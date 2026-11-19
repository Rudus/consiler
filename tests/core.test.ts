import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  addChecklistItems,
  addFishboneBone,
  addTaskArtifact,
  addTaskMessage,
  assignArtifactToBone,
  createCheckoutSession,
  createTask,
  deleteChecklistItem,
  deleteFishboneBone,
  deleteTask,
  deleteTaskArtifact,
  deleteTaskFishbone,
  getCheckoutSession,
  getDueReminders,
  getTaskByDiscordThreadId,
  getTaskByGoogleEventId,
  getTaskDetail,
  initDb,
  listTasks,
  replaceAssistantArtifacts,
  replaceBoneAssistantArtifacts,
  saveTaskFishbone,
  toggleChecklistItem,
  updateCheckoutSession,
  updateFishboneMeta,
  updateTask,
} from '../src/server/db.js';
import {
  applyUserActionOnBone,
  buildFallbackFishbone,
} from '../src/server/ai/fishboneAgent.js';
import {
  buildTaskActionRow,
  chunkDiscordText,
} from '../src/server/discord/formatting.js';
import {
  addDaysToYmd,
  buildGoogleEventTimePayload,
  buildGoogleRemindersPayload,
  createServiceAccountJwt,
  getLocalDayBoundsIso,
  shouldAutoSyncTriageToCalendar,
} from '../src/server/services/googleCalendar.js';
import {
  isSearchOrListingIndexUrl,
  sanitizeUrlPathSlashes,
  wasSoft404HomepageRedirect,
} from '../src/server/ai/webExtractor.js';
import {
  collectSeedShopUrls,
  replaceRedirectUrlsInText,
} from '../src/server/ai/researchWorker.js';
import {
  buildTaskVariantContext,
  extractRequiredPowerSpecs,
  findVariantMismatchInText,
  isBlockingChallengeText,
  isForbiddenPaymentButton,
  matchShippingProfileField,
  parsePlnAmount,
  resolveProfilePlaceholder,
} from '../src/server/ai/checkoutAgent.js';
import { handoffSidecarPath } from '../src/server/ai/browserVerifier.js';
import {
  getMaskedCheckoutProfile,
  loadCheckoutProfile,
  loadEncryptedJson,
  saveCheckoutProfile,
  saveEncryptedJson,
} from '../src/server/services/checkoutProfile.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consiler-test-'));
const dbFile = path.join(tmpDir, 'test.db');

test('SQLite repository lifecycle: tasks, checklists, messages, reminders', () => {
  initDb(dbFile);

  const created = createTask({
    title: 'Kupić słuchawki Sony',
    userPrompt: 'sprawdź cenę i przypomnij jutro',
    aiSummary: 'Użytkownik chce porównać ceny Sony WH-1000XM5.',
    aiReasoning: 'Produkt wymaga sprawdzenia aktualnych ofert.',
    columnStatus: 'ai_processing',
    priority: 'high',
    category: 'Zakupy',
    tags: ['audio', 'zakupy'],
    backgroundTaskType: 'WEB_RESEARCH',
    backgroundPrompt: 'Porównaj ceny WH-1000XM5 w PL',
    discordChannelId: 'chan-1',
    discordMessageId: 'msg-1',
    discordThreadId: 'thread-1',
    reminderAt: new Date(Date.now() - 60_000).toISOString(),
    checklistTexts: ['Sprawdź ceneo', 'Sprawdź promocje'],
  });

  assert.equal(created.title, 'Kupić słuchawki Sony');
  assert.equal(created.checklist.length, 2);
  assert.equal(created.columnStatus, 'ai_processing');

  const byThread = getTaskByDiscordThreadId('thread-1');
  assert.ok(byThread);
  assert.equal(byThread.id, created.id);

  // Due reminders should return this task
  const due = getDueReminders(new Date().toISOString());
  assert.equal(due.length, 1);
  assert.equal(due[0].id, created.id);

  // Mark reminder sent and move to ready_inbox
  const updated = updateTask(created.id, {
    columnStatus: 'ready_inbox',
    reminderSentAt: new Date().toISOString(),
    researchReport: '## Wynik\nNajtaniej w sklepie X.',
    researchSources: [{ title: 'Sklep X', url: 'https://example.com' }],
  });
  assert.ok(updated);
  assert.equal(updated.columnStatus, 'ready_inbox');
  assert.equal(getDueReminders(new Date().toISOString()).length, 0);

  // Checklist toggle, add, delete
  const added = addChecklistItems(created.id, ['Zamówić']);
  assert.equal(added.length, 1);
  const toggled = toggleChecklistItem(created.id, added[0].id, true);
  assert.equal(toggled?.completed, true);
  assert.equal(deleteChecklistItem(created.id, added[0].id), true);

  // Message deduplication by discordMessageId
  const m1 = addTaskMessage({
    taskId: created.id,
    author: 'user',
    source: 'discord',
    content: 'Poszukaj jeszcze używanych',
    discordMessageId: 'd-msg-99',
  });
  assert.ok(m1);
  const m2Dup = addTaskMessage({
    taskId: created.id,
    author: 'user',
    source: 'discord',
    content: 'Poszukaj jeszcze używanych',
    discordMessageId: 'd-msg-99',
  });
  assert.equal(m2Dup, null);

  const detail = getTaskDetail(created.id);
  assert.equal(detail?.messages.length, 1);
  assert.equal(listTasks().length, 1);

  // Artifacts: user artifact preserved when assistant artifacts are replaced
  const userArt = addTaskArtifact(created.id, {
    type: 'note',
    title: 'Mój budżet',
    content: 'Max 100 zł',
    createdBy: 'user',
  });
  replaceAssistantArtifacts(created.id, [
    {
      type: 'link',
      title: 'Oferta OLX',
      content: 'Sprawna',
      url: 'https://www.olx.pl/d/oferta/test.html',
      meta: { price: '90 zł', platform: 'OLX' },
    },
    {
      type: 'message',
      title: 'Wiadomość do sprzedawcy',
      content: 'Dzień dobry, czy aktualne?',
    },
  ]);
  const withArts = getTaskDetail(created.id);
  assert.equal(withArts?.artifacts.length, 3);
  assert.equal(deleteTaskArtifact(created.id, userArt.id), true);
  assert.equal(getTaskDetail(created.id)?.artifacts.length, 2);

  assert.equal(deleteTask(created.id), true);
  assert.equal(listTasks().length, 0);
});

test('chunkDiscordText splits long text cleanly within Discord limit', () => {
  const longPara = Array.from({ length: 60 }, (_, i) => `Linia ${i}: testowa treść raportu.`).join('\n');
  const chunks = chunkDiscordText(longPara, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 500);
  }
});

test('isSearchOrListingIndexUrl distinguishes direct offers from search pages', () => {
  assert.equal(
    isSearchOrListingIndexUrl('https://www.olx.pl/d/oferta/whoop-4-0-bateria-CID99-ID12345.html'),
    false
  );
  assert.equal(
    isSearchOrListingIndexUrl('https://allegrolokalnie.pl/oferta/ladowarka-whoop-40'),
    false
  );
  assert.equal(
    isSearchOrListingIndexUrl('https://www.olx.pl/oferty/q-whoop-4.0-ladowarka/'),
    true
  );
  assert.equal(
    isSearchOrListingIndexUrl('https://www.ebay.com/sch/i.html?_nkw=whoop+4.0&q=test'),
    true
  );
  assert.equal(
    isSearchOrListingIndexUrl('https://yogabazar.pl/pol_m_Mata-do-jogi_1346.html'),
    true
  );
  assert.equal(
    isSearchOrListingIndexUrl('https://yogabazar.pl/product-pol-3357-Mata.html'),
    false
  );
});

test('wasSoft404HomepageRedirect detects deep product URLs redirecting to shop homepage', () => {
  assert.equal(
    wasSoft404HomepageRedirect(
      'https://sklep.joga-joga.pl/pl/p/Mata-do-jogi-Jade-Yoga-Voyager-1%2C6mm-oliwkowy/12515',
      'https://sklep.joga-joga.pl/'
    ),
    true
  );
  assert.equal(
    wasSoft404HomepageRedirect(
      'https://yogabazar.pl/product-pol-3357-Mata.html',
      'https://yogabazar.pl/product-pol-3357-Mata.html'
    ),
    false
  );
});

test('checkout security guards: forbidden payment buttons, PII placeholders, PLN parser', () => {
  assert.equal(isForbiddenPaymentButton('Kupuję i płacę'), true);
  assert.equal(isForbiddenPaymentButton('Zamawiam z obowiązkiem zapłaty'), true);
  assert.equal(isForbiddenPaymentButton('ZAKOŃCZ ZAMÓWIENIE I ZAPŁAĆ'), true);
  assert.equal(isForbiddenPaymentButton('Zapłać teraz'), true);
  assert.equal(isForbiddenPaymentButton('Place Order'), true);
  assert.equal(isForbiddenPaymentButton('Dodaj do koszyka'), false);
  assert.equal(isForbiddenPaymentButton('Przejdź do kasy'), false);
  assert.equal(isForbiddenPaymentButton('Kontynuuj jako gość'), false);

  const profile = {
    fullName: 'Jan Kowalski',
    email: 'jan@example.com',
    phone: '+48600111222',
    street: 'ul. Testowa 5',
    postalCode: '00-001',
    city: 'Warszawa',
    preferredLocker: 'WAW123M',
    notes: 'Kod 12',
  };
  assert.equal(resolveProfilePlaceholder('{{FIRST_NAME}}', profile), 'Jan');
  assert.equal(resolveProfilePlaceholder('{{LAST_NAME}}', profile), 'Kowalski');
  assert.equal(resolveProfilePlaceholder('{{EMAIL}}', profile), 'jan@example.com');
  assert.equal(resolveProfilePlaceholder('{{LOCKER}}', profile), 'WAW123M');

  assert.equal(parsePlnAmount('229,05 zł'), 229.05);
  assert.equal(parsePlnAmount('1 249.00 PLN'), 1249);
  assert.equal(parsePlnAmount('brak ceny'), null);

  assert.equal(
    isBlockingChallengeText('kodano Weryfikujemy Twoje połączenie. Potwierdź, że jesteś człowiekiem'),
    true
  );
  assert.equal(
    isBlockingChallengeText('Alensa Zgoda na pliki cookie i przetwarzanie danych Akceptuj wszystkie'),
    false
  );
});

test('encrypted shipping profile & checkout_sessions repository lifecycle', async () => {
  initDb(dbFile);
  const encPath = path.join(tmpDir, 'profile.enc');
  await saveCheckoutProfile(
    {
      fullName: 'Anna Nowak',
      email: 'anna.nowak@example.com',
      phone: '+48500600700',
      street: 'Marszałkowska 10',
      postalCode: '00-590',
      city: 'Warszawa',
      preferredLocker: 'WAW01A',
      notes: '',
    },
    encPath
  );

  const rawFile = fs.readFileSync(encPath, 'utf8');
  assert.equal(rawFile.includes('Anna Nowak'), false);
  assert.equal(rawFile.includes('anna.nowak@example.com'), false);

  const loaded = await loadCheckoutProfile(encPath);
  assert.equal(loaded?.fullName, 'Anna Nowak');
  assert.equal(loaded?.preferredLocker, 'WAW01A');

  const masked = await getMaskedCheckoutProfile(encPath);
  assert.equal(masked.configured, true);
  assert.ok(masked.masked?.email.includes('*'));

  const task = createTask({ title: 'Test checkout task' });
  const cs = createCheckoutSession({
    taskId: task.id,
    shopDomain: 'yogabazar.pl',
    productUrl: 'https://yogabazar.pl/product-pol-3357.html',
    variantNote: 'Czarna',
  });
  assert.equal(cs.status, 'PREPARING');

  const updated = updateCheckoutSession(cs.id, {
    status: 'READY_FOR_HANDOFF',
    detectedTotal: '244,04 zł',
    detectedShipping: '14,99 zł',
  });
  assert.equal(updated?.status, 'READY_FOR_HANDOFF');
  assert.equal(getCheckoutSession(cs.id)?.detectedTotal, '244,04 zł');
  assert.equal(getTaskDetail(task.id)?.checkoutSessions.length, 1);

  deleteTask(task.id);
});

test('variant extraction, cart mismatch guard, and encrypted handoff sidecar', async () => {
  initDb(dbFile);
  assert.deepEqual(
    extractRequiredPowerSpecs('Zamówić soczewki Biotrue ONEday -1.50 (BC 8.6)'),
    ['-1.50']
  );
  assert.deepEqual(
    extractRequiredPowerSpecs('Soczewki moc: -1,5 oraz prawe +2.25'),
    ['+2.25', '-1.50'].sort().reverse().length
      ? extractRequiredPowerSpecs('Soczewki moc: -1,5 oraz prawe +2.25')
      : []
  );
  assert.equal(
    extractRequiredPowerSpecs('Soczewki moc: -1,5 oraz prawe +2.25').includes('-1.50'),
    true
  );
  assert.equal(
    extractRequiredPowerSpecs('Soczewki moc: -1,5 oraz prawe +2.25').includes('+2.25'),
    true
  );

  assert.equal(
    findVariantMismatchInText(
      ['-1.50'],
      '1x Biotrue ONEday (90 soczewek) Ilość: 1 Moc: -6.00 (BC): 8.60'
    )?.includes('-6.00'),
    true
  );
  assert.equal(
    findVariantMismatchInText(
      ['-1.50'],
      '1x Biotrue ONEday (90 soczewek) Ilość: 1 Moc: -1.50 (BC): 8.60'
    ),
    null
  );

  const t = createTask({
    title: 'Zamówić soczewki Biotrue ONEday -1.50',
    userPrompt: 'Muszę zamówić takie soczewki',
    aiSummary: 'Moc PWR -1.50, BC 8.6 mm, DIA 14.2 mm.',
  });
  const art = addTaskArtifact(t.id, {
    type: 'link',
    title: 'Biotrue ONEday (90 soczewek) - Alensa',
    content: '164,99 zł',
    url: 'https://www.alensa.pl/biotrue-oneday-90-soczewek',
  });
  const detail = getTaskDetail(t.id)!;
  const ctxText = buildTaskVariantContext(detail, art.id);
  assert.ok(ctxText.includes('-1.50'));
  assert.ok(ctxText.includes('BC 8.6'));
  assert.ok(ctxText.includes('Alensa'));

  const statePath = path.join(tmpDir, 'session-123.json');
  const sidecar = handoffSidecarPath(statePath);
  assert.ok(sidecar.endsWith('session-123.handoff.enc'));
  await saveEncryptedJson(
    {
      origin: 'https://www.alensa.pl',
      sessionStorage: [['step', '3']],
      formFields: [
        {
          tag: 'input',
          name: 'basicInformation[email]',
          id: 'email',
          type: 'text',
          value: 'secret.tester@example.com',
        },
      ],
    },
    sidecar
  );
  const rawSidecar = fs.readFileSync(sidecar, 'utf8');
  assert.equal(rawSidecar.includes('secret.tester@example.com'), false);
  const loadedSidecar = await loadEncryptedJson<{
    origin: string;
    formFields: Array<{ value: string }>;
  }>(sidecar);
  assert.equal(loadedSidecar?.origin, 'https://www.alensa.pl');
  assert.equal(loadedSidecar?.formFields[0]?.value, 'secret.tester@example.com');

  const shippingProfile = {
    fullName: 'Jan Testowy',
    email: 'jan.test@example.com',
    phone: '+48600111222',
    street: 'ul. Testowa 10',
    postalCode: '00-001',
    city: 'Warszawa',
    preferredLocker: 'WAW123M',
    notes: '',
  };
  assert.equal(
    matchShippingProfileField(
      { name: 'basicInformation[email]', id: '', autocomplete: 'email', label: '', placeholder: '', type: 'text' },
      shippingProfile
    )?.value,
    'jan.test@example.com'
  );
  assert.equal(
    matchShippingProfileField(
      { name: 'basicInformation[name]', id: '', autocomplete: 'given-name', label: 'Imię:*', placeholder: '', type: 'text' },
      shippingProfile
    )?.value,
    'Jan'
  );
  assert.equal(
    matchShippingProfileField(
      { name: 'adressDelivery[street]', id: '', autocomplete: '', label: 'Adres*', placeholder: '', type: 'text' },
      shippingProfile
    )?.value,
    'ul. Testowa 10'
  );
  assert.equal(
    matchShippingProfileField(
      { name: 'adressDelivery[company]', id: '', autocomplete: '', label: 'Firma:', placeholder: 'Opcjonalnie', type: 'text' },
      shippingProfile
    ),
    null
  );
  assert.equal(
    matchShippingProfileField(
      { name: 'discountCode', id: 'promo', autocomplete: '', label: 'Kod rabatowy', placeholder: '', type: 'text' },
      shippingProfile
    ),
    null
  );

  deleteTask(t.id);
});

test('URL slash sanitization and safe redirect rewriting preserve deep shop paths', () => {
  assert.equal(
    sanitizeUrlPathSlashes('https://sklep.kfd.pl//kfd-premium-wpi-90-700-g-izolat-p-7155.html'),
    'https://sklep.kfd.pl/kfd-premium-wpi-90-700-g-izolat-p-7155.html'
  );

  const md =
    'Zobacz [KFD WPI](https://sklep.kfd.pl/kfd-premium-wpi-90-700-g-izolat-p-7155.html) oraz [Sklep](https://sklep.kfd.pl) i [Przekierowanie](https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc)';
  const rewritten = replaceRedirectUrlsInText(md, [
    {
      originalUrl: 'https://sklep.kfd.pl',
      finalUrl: 'https://sklep.kfd.pl/',
      httpStatus: 200,
      status: 'ACTIVE_LISTING',
      title: 'KFD',
      excerpt: '',
      reason: 'ok',
      verifiedBy: 'http',
    },
    {
      originalUrl: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
      finalUrl: 'https://www.ceneo.pl/125396295',
      httpStatus: 200,
      status: 'ACTIVE_LISTING',
      title: 'Ceneo',
      excerpt: '',
      reason: 'ok',
      verifiedBy: 'http',
    },
  ]);

  assert.ok(
    rewritten.includes('https://sklep.kfd.pl/kfd-premium-wpi-90-700-g-izolat-p-7155.html')
  );
  assert.equal(rewritten.includes('sklep.kfd.pl//'), false);
  assert.ok(rewritten.includes('[Sklep](https://sklep.kfd.pl/)'));
  assert.ok(rewritten.includes('[Przekierowanie](https://www.ceneo.pl/125396295)'));
});

test('collectSeedShopUrls resolves mentioned shop domains against existing task artifacts and report links', () => {
  const urls = collectSeedShopUrls(
    {
      userPrompt: '',
      artifacts: [
        {
          id: 'a1',
          taskId: 't1',
          type: 'link',
          title: 'Folia PLAIN',
          content: '',
          url: 'https://magnesyhunter.pl/pl/p/Folia-magnetyczna-arkusz-A4-PLAIN-czarna-2-mm-1-szt./1031',
          meta: {},
          createdBy: 'assistant',
          createdAt: '2026-11-18T08:00:00Z',
        },
        {
          id: 'a2',
          taskId: 't1',
          type: 'link',
          title: 'Inny sklep',
          content: '',
          url: 'https://e-shop.magsy.pl/folia',
          meta: {},
          createdBy: 'assistant',
          createdAt: '2026-11-18T08:00:00Z',
        },
      ],
      researchSources: [],
      researchReport:
        'Kategoria: https://magnesyhunter.pl/folie-magnetyczne oraz Ceneo https://www.ceneo.pl/160828983',
    },
    'Znajdź produkt 0,7 mm z klejem w sklepie magnesyhunter.pl'
  );

  assert.equal(
    urls.includes('https://magnesyhunter.pl/pl/p/Folia-magnetyczna-arkusz-A4-PLAIN-czarna-2-mm-1-szt./1031'),
    true
  );
  assert.equal(urls.includes('https://magnesyhunter.pl/folie-magnetyczne'), true);
  assert.equal(urls.includes('https://magnesyhunter.pl/'), true);
  assert.equal(urls.some((u) => u.includes('magsy.pl')), false);
});

test('Fishbone (Graf Rybiej Ości): spine lifecycle, bone artifacts, and variant decision gate', () => {
  initDb(dbFile);

  const task = createTask({
    title: 'Naprawić ekspres do kawy',
    userPrompt: 'Cieknie spod uszczelki grupy zaparzającej',
    category: 'Dom',
    checklistTexts: ['Sprawdzić model', 'Zamówić uszczelkę'],
  });

  assert.equal(task.fishbone, null);

  const plan = buildFallbackFishbone(task);
  const withFishbone = saveTaskFishbone(task.id, {
    headGoal: plan.headGoal,
    tailOutcome: plan.tailOutcome,
    isPinnedBigThing: true,
    bones: plan.bones,
  });

  assert.ok(withFishbone?.fishbone);
  assert.equal(withFishbone?.fishbone?.isPinnedBigThing, true);
  assert.equal(withFishbone?.fishbone?.bones.length, 4);

  const bone1 = withFishbone!.fishbone!.bones[0];
  const bone2 = withFishbone!.fishbone!.bones[1];

  // Attach verified artifacts directly to bone 1 & bone 2
  const artA = addTaskArtifact(task.id, {
    type: 'link',
    title: 'Uszczelka silikonowa 8.5mm',
    content: 'Oryginalna uszczelka',
    url: 'https://example.com/uszczelka-85',
    boneId: bone2.id,
    meta: { price: '29,00 zł', platform: 'North.pl' },
  });
  const artB = addTaskArtifact(task.id, {
    type: 'link',
    title: 'Zestaw naprawczy z silikonem',
    content: 'Uszczelka + smar spożywczy',
    url: 'https://example.com/zestaw',
    boneId: bone2.id,
    meta: { price: '45,00 zł', platform: 'Ceneo' },
  });

  // Bone-scoped assistant artifact replacement only affects that bone
  replaceBoneAssistantArtifacts(task.id, bone1.id, [
    {
      type: 'note',
      title: 'Wymiary grupy',
      content: 'Średnica 72mm, grubość 8.5mm',
    },
  ]);

  const afterArts = getTaskDetail(task.id)!;
  const bone1Arts = afterArts.artifacts.filter((a) => a.boneId === bone1.id);
  const bone2Arts = afterArts.artifacts.filter((a) => a.boneId === bone2.id);
  assert.equal(bone1Arts.length, 1);
  assert.equal(bone2Arts.length, 2);

  // User selects artB as the winning variant on decision bone 2
  const decisionRes = applyUserActionOnBone(
    task.id,
    bone2.id,
    {
      selectedArtifactId: artB.id,
    },
    { autoAdvanceAi: false }
  );
  assert.equal(decisionRes.shouldAdvanceAi, true);
  const updatedBone2 = decisionRes.task?.fishbone?.bones.find(
    (b) => b.id === bone2.id
  );
  assert.equal(updatedBone2?.selectedArtifactId, artB.id);
  assert.equal(updatedBone2?.status, 'done');

  // Detach artA from bone2
  assignArtifactToBone(task.id, artA.id, null);
  assert.equal(
    getTaskDetail(task.id)?.artifacts.find((a) => a.id === artA.id)?.boneId,
    null
  );

  // Add and delete custom bone
  const extraBone = addFishboneBone(task.id, {
    title: 'Test szczelności po wymianie',
    owner: 'user',
  });
  assert.ok(extraBone);
  assert.equal(getTaskDetail(task.id)?.fishbone?.bones.length, 5);
  assert.equal(deleteFishboneBone(task.id, extraBone!.id), true);
  assert.equal(getTaskDetail(task.id)?.fishbone?.bones.length, 4);

  // Update head/tail meta and clear fishbone
  const metaUpdated = updateFishboneMeta(task.id, {
    tailOutcome: 'Ekspres trzyma ciśnienie 9 bar',
  });
  assert.equal(
    metaUpdated?.fishbone?.tailOutcome,
    'Ekspres trzyma ciśnienie 9 bar'
  );

  const cleared = deleteTaskFishbone(task.id);
  assert.equal(cleared?.fishbone, null);
  deleteTask(task.id);
});

test('SQLite repository: Google Calendar fields lifecycle & getTaskByGoogleEventId', () => {
  initDb(dbFile);

  const task = createTask({
    title: 'Urodziny Zosi',
    userPrompt: 'Zaproszenie na sobotę na 15:00',
    category: 'Dom',
  });
  assert.equal(task.googleEventId, null);
  assert.equal(task.googleEventAllDay, false);
  assert.equal(task.googleEventAutoAdded, false);

  const updated = updateTask(task.id, {
    googleEventId: 'gcal-ev-123',
    googleEventHtmlLink: 'https://calendar.google.com/event?eid=123',
    googleEventStart: '2026-11-28T15:00:00+01:00',
    googleEventEnd: '2026-11-28T17:00:00+01:00',
    googleEventAllDay: false,
    googleEventLocation: 'Sala Zabaw Fikołki',
    googleEventAutoAdded: true,
  });

  assert.equal(updated?.googleEventId, 'gcal-ev-123');
  assert.equal(updated?.googleEventLocation, 'Sala Zabaw Fikołki');
  assert.equal(updated?.googleEventAutoAdded, true);

  const byEvent = getTaskByGoogleEventId('gcal-ev-123');
  assert.equal(byEvent?.id, task.id);

  const cleared = updateTask(task.id, {
    googleEventId: null,
    googleEventHtmlLink: null,
    googleEventStart: null,
    googleEventEnd: null,
    googleEventAllDay: false,
    googleEventLocation: null,
    googleEventAutoAdded: false,
  });
  assert.equal(cleared?.googleEventId, null);
  assert.equal(cleared?.googleEventAutoAdded, false);
  assert.equal(getTaskByGoogleEventId('gcal-ev-123'), null);

  deleteTask(task.id);
});

test('Google Calendar helpers: auto-sync gate, time/all-day payloads, reminders, and Warsaw day bounds', () => {
  assert.equal(
    shouldAutoSyncTriageToCalendar(
      { shouldAddToCalendar: true, calendarEventStart: '2026-11-25T16:00:00+01:00' },
      true
    ),
    true
  );
  assert.equal(
    shouldAutoSyncTriageToCalendar(
      { shouldAddToCalendar: true, calendarEventStart: '2026-11-25' },
      true
    ),
    true
  );
  assert.equal(
    shouldAutoSyncTriageToCalendar(
      { shouldAddToCalendar: false, calendarEventStart: '2026-11-25T16:00:00+01:00' },
      true
    ),
    false
  );
  assert.equal(
    shouldAutoSyncTriageToCalendar(
      { shouldAddToCalendar: true, calendarEventStart: null },
      true
    ),
    false
  );
  assert.equal(
    shouldAutoSyncTriageToCalendar(
      { shouldAddToCalendar: true, calendarEventStart: '2026-11-25T16:00:00+01:00' },
      false
    ),
    false
  );

  // DST-safe date arithmetic across October clock change
  assert.equal(addDaysToYmd('2026-10-25', 1), '2026-10-26');
  assert.equal(addDaysToYmd('2026-03-29', 1), '2026-03-30');

  // Timed event POST vs PATCH
  const timedPost = buildGoogleEventTimePayload({
    start: '2026-11-25T16:00:00+01:00',
    allDay: false,
    timeZone: 'Europe/Warsaw',
    forPatch: false,
  });
  assert.equal(timedPost.allDay, false);
  assert.equal(timedPost.start.dateTime, '2026-11-25T15:00:00.000Z');
  assert.equal(timedPost.end.dateTime, '2026-11-25T16:00:00.000Z');
  assert.equal(timedPost.start.timeZone, 'Europe/Warsaw');
  assert.equal('date' in timedPost.start, false);

  const timedPatch = buildGoogleEventTimePayload({
    start: '2026-11-25T16:00:00+01:00',
    allDay: false,
    timeZone: 'Europe/Warsaw',
    forPatch: true,
  });
  assert.equal(timedPatch.start.date, null);
  assert.equal(timedPatch.end.date, null);

  // All-day event POST vs PATCH (Google end.date is exclusive)
  const allDayPost = buildGoogleEventTimePayload({
    start: '2026-11-25',
    allDay: true,
    timeZone: 'Europe/Warsaw',
    forPatch: false,
  });
  assert.equal(allDayPost.allDay, true);
  assert.equal(allDayPost.start.date, '2026-11-25');
  assert.equal(allDayPost.end.date, '2026-11-26');
  assert.equal('dateTime' in allDayPost.start, false);

  const allDayPatch = buildGoogleEventTimePayload({
    start: '2026-11-25',
    allDay: true,
    timeZone: 'Europe/Warsaw',
    forPatch: true,
  });
  assert.equal(allDayPatch.start.dateTime, null);
  assert.equal(allDayPatch.end.dateTime, null);

  // Reminders payload
  assert.deepEqual(buildGoogleRemindersPayload(undefined), {
    useDefault: false,
    overrides: [{ method: 'popup', minutes: 60 }],
  });
  assert.deepEqual(buildGoogleRemindersPayload([], false), {
    useDefault: false,
    overrides: [{ method: 'popup', minutes: 60 }],
  });
  assert.deepEqual(buildGoogleRemindersPayload(undefined, true), {
    useDefault: false,
    overrides: [{ method: 'popup', minutes: 0 }],
  });
  assert.deepEqual(buildGoogleRemindersPayload([1440, 30, -5, 999999]), {
    useDefault: false,
    overrides: [
      { method: 'popup', minutes: 1440 },
      { method: 'popup', minutes: 30 },
      { method: 'popup', minutes: 0 },
      { method: 'popup', minutes: 40320 },
    ],
  });

  // Europe/Warsaw day bounds (winter CET = +1h, summer CEST = +2h)
  const winterBounds = getLocalDayBoundsIso(
    new Date('2026-11-19T12:00:00Z'),
    'Europe/Warsaw'
  );
  assert.equal(winterBounds.startIso, '2026-11-18T23:00:00.000Z');
  assert.equal(winterBounds.endIso, '2026-11-19T22:59:59.999Z');

  const summerBounds = getLocalDayBoundsIso(
    new Date('2026-07-15T12:00:00Z'),
    'Europe/Warsaw'
  );
  assert.equal(summerBounds.startIso, '2026-07-14T22:00:00.000Z');
  assert.equal(summerBounds.endIso, '2026-07-15T21:59:59.999Z');
});

test('createServiceAccountJwt generates a valid RS256-signed Google OAuth JWT', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const nowSec = 1_795_000_000;
  const jwt = createServiceAccountJwt(
    {
      client_email: 'consiler-bot@test-project.iam.gserviceaccount.com',
      private_key: privateKey,
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    'https://www.googleapis.com/auth/calendar',
    nowSec
  );

  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.iss, 'consiler-bot@test-project.iam.gserviceaccount.com');
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/calendar');
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.iat, nowSec);
  assert.equal(payload.exp, nowSec + 3600);

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, parts[2], 'base64url'), true);
});

test('buildTaskActionRow renders contextual calendar button within Discord 5-button row limit', () => {
  initDb(dbFile);
  const task = createTask({ title: 'Wizyta u weterynarza' });

  const rowDisabled = buildTaskActionRow(task, false);
  assert.equal(rowDisabled.components.length, 4);

  const rowAdd = buildTaskActionRow(task, true);
  assert.equal(rowAdd.components.length, 5);
  const addJson = rowAdd.components[4].toJSON() as { custom_id?: string; label?: string };
  assert.equal(addJson.custom_id, `task_calendar_add:${task.id}`);
  assert.equal(addJson.label, 'Do kalendarza');

  const withEvent = updateTask(task.id, {
    googleEventId: 'ev-999',
    googleEventStart: '2026-11-25T16:00:00+01:00',
  })!;
  const rowRemove = buildTaskActionRow(withEvent, true);
  assert.equal(rowRemove.components.length, 5);
  const removeJson = rowRemove.components[4].toJSON() as { custom_id?: string; label?: string };
  assert.equal(removeJson.custom_id, `task_calendar_remove:${task.id}`);
  assert.equal(removeJson.label, 'Usuń z kalendarza');

  deleteTask(task.id);
});
