// index.js
//
// ------------------------------------------------------
// 1. 모듈 불러오기
// ------------------------------------------------------
const express    = require('express');
const bodyParser = require('body-parser');
const path       = require('path');
const fs         = require('fs');
const puppeteer  = require('puppeteer');
const { google } = require('googleapis');
const fetch      = require('node-fetch');
const cron       = require('node-cron');   // ★ 자동 업로드

//
// ------------------------------------------------------
// 2. Express 앱 초기화
// ------------------------------------------------------
const app = express();

//
// ------------------------------------------------------
// 3. body-parser 설정
// ------------------------------------------------------
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

//
// ------------------------------------------------------
// 4. 정적 폴더
// ------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

//
// ------------------------------------------------------
// 5. HTML 라우팅
// ------------------------------------------------------
app.get('/',       (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin',  (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/result', (_, res) => res.sendFile(path.join(__dirname, 'public', 'result.html')));

//
// ------------------------------------------------------
// 6. Google Sheets API 연결
// ------------------------------------------------------
const serviceAccount = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'capsule-445214-2ba83b9a8bb0.json'), 'utf8')
);
const auth = new google.auth.JWT({
  email : serviceAccount.client_email,
  key   : serviceAccount.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets        = google.sheets({ version: 'v4', auth });
const spreadsheetId = '1Qo1m-Sy-NWIbfW948e-bUH7BHSvcRv2jrjMq3nDhJA0';
const sheetName     = '82Database';
const MAIN_RANGE    = `${sheetName}!A2:O40`;   // A~O
const BACKUP_RANGE  = `${sheetName}!A41:O90`;  // A~P (P=timestamp)
const CONFIG_RANGE  = `${sheetName}!U27:U27`;  // 자동 업로드 스위치

//
// ------------------------------------------------------
// 7. 유틸
// ------------------------------------------------------
/* --- (★추가) KST 현재 시각을 Date 객체로 ---------------------------------- */
const kstNow = () =>
  new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));

/* --- (★추가) 오전 11 시 컷오프 업무-기준일 yyyy-mm-dd --------------------- */
function workDateStr() {
  const d = kstNow();
  if (d.getHours() < 11) d.setDate(d.getDate() - 1);  // 11 시 이전이면 전날
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* todaySheetName → workDateStr 반환 ---------------------------------------- */
function todaySheetName() { return workDateStr(); }

function formatDate8(str) {
  if (typeof str !== 'string' || !/^\d{8}$/.test(str)) return str;
  return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
}
const HEADERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H',
                 'I', 'J', 'K', 'L', 'M', 'N', 'O'];

//
// ------------------------------------------------------
// 8. PMS 데이터 크롤링 함수 (이름 중복 → “이름 순번” 부여 포함)
// ------------------------------------------------------
async function fetchPmsData(from, to) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      slowMo: 50,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox']
    });
    const page = await browser.newPage();

    /* 1) 로그인 */
    await page.goto('https://82capsule.oapms.co.kr/', { waitUntil: 'networkidle2' });
    await page.type('#id.login_inp.login_inp01', '82capsule');
    await page.type('#password.login_inp.login_inp02', '1');
    await Promise.all([
      page.click('#loginBtn.login_btn'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    /* 2) 예약 검색 페이지 */
    await page.goto(
      'https://82capsule.oapms.co.kr/kor/fo/reve/RoomReveSearchFrm',
      { waitUntil: 'networkidle2' }
    );
    await page.waitForSelector('#reve_tran_adat_from');

    /* 3) 날짜 입력 */
    await page.evaluate((f, t) => {
      document.getElementById('reve_tran_adat_from').value = f;
      document.getElementById('reve_tran_adat_to').value   = t;
    }, from, to);

    /* 4) CHECK-IN 필터 체크박스 해제 */
    await page.waitForSelector('input.searchCheck[type="checkbox"]');
    await page.evaluate(() => {
      const cb = document.querySelector('input.searchCheck[type="checkbox"]');
      if (cb && cb.checked) {
        cb.checked = false;
        cb.classList.remove('off');
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    /* 5) 조회 */
    await page.waitForSelector('#btnSearch.btn_style01.add_btn', { visible: true });
    await page.evaluate(() => document.querySelector('#btnSearch').click());
    await page.waitForSelector('tr.reveRow', { timeout: 10_000 });

    /* 6) 결과 파싱 */
    let results = await page.$$eval('tr.reveRow', trs => {
      const seen = new Set();
      return trs.reduce((acc, tr) => {
        if (!tr.querySelector('input[name="reve_tran_acno"]')) return acc;

        const oacno = tr.getAttribute('data-oacno') || '';
        const rseq  = tr.getAttribute('data-rseq')  || '';
        const key   = `${oacno}_${rseq}`;
        if (seen.has(key)) return acc;
        seen.add(key);

        const getVal = n => {
          const inp = tr.querySelector(`input[name="${n}"]`);
          return inp ? inp.value.trim() : '';
        };
        const ttl = [...tr.querySelectorAll('td[title]')];

        acc.push({
          A: ttl[1]?.getAttribute('title').trim() || '',
          B: getVal('reve_tran_acno'),
          C: oacno,
          D: getVal('reve_tran_rono'),
          E: getVal('rtype_name'),
          F: getVal('reve_tran_rcnt'),
          G: getVal('reve_tran_adat'),
          H: getVal('reve_tran_days'),
          I: getVal('reve_tran_ddat'),
          J: getVal('reve_tran_adult'),
          K: getVal('reve_tran_child'),
          L: getVal('reve_mast_rname'),
          M: ttl[13]?.getAttribute('title').trim() || '',
          N: getVal('reve_tran_gname'),
          O: '대기중'
        });
        return acc;
      }, []);
    });

    /* 7) 날짜 포맷 보정 */
    results = results.map(r => ({
      ...r,
      G: formatDate8(r.G),
      I: formatDate8(r.I)
    }));

    /* 8) 이름 중복 → 순번 붙이기 */
    const totalCnt = Object.create(null);
    const curIdx   = Object.create(null);
    results.forEach(r => { totalCnt[r.N] = (totalCnt[r.N] || 0) + 1; });
    results.forEach(r => {
      if (totalCnt[r.N] > 1) {
        curIdx[r.N] = (curIdx[r.N] || 0) + 1;
        r.N = `${r.N} ${curIdx[r.N]}`;
      }
    });

    return results;
  } finally {
    if (browser) await browser.close();
  }
}

//
// ------------------------------------------------------
// 9. rows 업로드  (CHECK-IN 보존 + 빈 O열 → 대기중)
// ------------------------------------------------------
async function uploadRows(rows2D) {
  const prev = await sheets.spreadsheets.values.get({ spreadsheetId, range: MAIN_RANGE });
  const statusMap = new Map();
  (prev.data.values || []).forEach(r => {
    if ((r[14] || '') === '체크인' && r[2]) statusMap.set(r[2], '체크인');
  });

  rows2D.forEach(r => {
    while (r.length < 15) r.push('');
    if (statusMap.get(r[2]) === '체크인') r[14] = '체크인';
    else if ((r[14] || '').trim() === '') r[14] = '대기중';
  });

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: MAIN_RANGE });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A2:O38`,
    valueInputOption: 'RAW',
    insertDataOption: 'OVERWRITE',
    resource: { values: rows2D }
  });
}

//
// ------------------------------------------------------
// 10. 백업/삭제 & 데일리 시트 함수들
// ------------------------------------------------------
let lastPreparedDate = '';

/* ---------- backupAndDeleteJob ------------------------------------------ */
async function backupAndDeleteJob() {
  console.log('[backupAndDeleteJob] 실행');
  try {
    const [mainResp, backupResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: MAIN_RANGE }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: BACKUP_RANGE })
    ]);
    const mainRows   = mainResp.data.values   || [];
    const backupRows = backupResp.data.values || [];

    /* 새 백업 */
    const keySet = new Set();
    backupRows.forEach(r => {
      const k = `${(r[2] || '').trim()}||${(r[6] || '').trim()}`;
      if (k !== '||') keySet.add(k);
    });
    const newBackup = [];
    mainRows.forEach(r => {
      const dur = parseInt(r[7], 10);
      if (!isNaN(dur) && dur >= 2) {
        const k = `${(r[2] || '').trim()}||${(r[6] || '').trim()}`;
        if (k && !keySet.has(k)) {
          const row = r.slice(0, 15);
          while (row.length < 15) row.push('');
          row.push(new Date().toISOString());
          newBackup.push(row);
          keySet.add(k);
        }
      }
    });
    if (newBackup.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: BACKUP_RANGE,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: newBackup }
      });
      console.log('[backup] 추가:', newBackup.length);
    }

    /* 만료 삭제 */
    const now = Date.now(), deletes = [];
    (await sheets.spreadsheets.values.get({ spreadsheetId, range: BACKUP_RANGE }))
      .data.values?.forEach((r, i) => {
        const dur    = parseInt(r[7], 10);
        const tsCell = r.length >= 16 ? r[15] : r[14];
        const ts     = new Date(tsCell).getTime();
        if (!isNaN(dur) && !isNaN(ts) && now - ts >= dur * 86_400_000) {
          deletes.push({
            deleteDimension: { range: { sheetId: 0, dimension: 'ROWS',
                                        startIndex: 41 + i, endIndex: 41 + i + 1 } }
          });
        }
      });
    if (deletes.length) {
      deletes.sort((a, b) =>
        b.deleteDimension.range.startIndex - a.deleteDimension.range.startIndex);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: { requests: deletes }
      });
      console.log('[backup] 만료 삭제:', deletes.length);
    }
  } catch (err) {
    console.error('[backupAndDeleteJob] 오류:', err);
  }
}

/* ---------- createOrRefreshDailySheet ----------------------------------- */
const DAILY_HEADERS = [
  '예약일자', 'ACCT#', 'OTA 예약번호', '객실#', '객실타입', '객실 수',
  '입실일', '박 수', '퇴실일', '성인', '소인', '그룹명', '거래처', '고객명', '체크인여부'
];

async function createOrRefreshDailySheet(isInitial) {
  const dateName = todaySheetName();          // ← 업무-기준일
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  });
  const exists = meta.data.sheets.some(s => s.properties.title === dateName);
  if (isInitial && !exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title: dateName } } }] }
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${dateName}!A1:O1`,
    valueInputOption: 'RAW',
    resource: { values: [DAILY_HEADERS] }
  });

  const [mainResp, backResp] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: MAIN_RANGE }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: BACKUP_RANGE })
  ]);

  const raw   = [...(mainResp.data.values || []),
                 ...(backResp.data.values || []).map(r => r.slice(0, 15))];
  const seen  = new Set();
  const rows  = [];

  for (const r of raw) {
    const room = r[3] || '';
    if (room && !seen.has(room)) {
      seen.add(room);
      rows.push([
        r[0] || '', r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || '',
        formatDate8(r[6] || ''), r[7] || '', formatDate8(r[8] || ''),
        r[9] || '', r[10] || '', r[11] || '', r[12] || '', r[13] || '',
        r[14] || '대기중'
      ]);
      if (rows.length >= 49) break;
    }
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${dateName}!A2:O50`
  });
  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${dateName}!A2:O${rows.length + 1}`,
      valueInputOption: 'RAW',
      resource: { values: rows }
    });
  }

  const total   = rows.length;
  const checked = rows.filter(r => r[14] === '체크인').length;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${dateName}!P1:Q2`,
    valueInputOption: 'RAW',
    resource: {
      values: [
        ['체크인율', total ? ((checked / total) * 100).toFixed(2) + '%' : '0.00%'],
        ['노쇼율',   total ? (((total - checked) / total) * 100).toFixed(2) + '%' : '0.00%']
      ]
    }
  });

  await backupAndDeleteJob();
  lastPreparedDate = dateName;
  console.log('[createOrRefreshDailySheet] ready:', dateName);
}

/* ---------- ensureTodaySheet -------------------------------------------- */
async function ensureTodaySheet() {
  if (lastPreparedDate === todaySheetName()) return;
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId, fields: 'sheets.properties.title'
    });
    const exists = meta.data.sheets.some(
      s => s.properties.title === todaySheetName()
    );
    await createOrRefreshDailySheet(!exists);
  } catch (err) {
    console.error('[ensureTodaySheet] 실패:', err);
  }
}

/* ---------- syncCheckinToBackup ----------------------------------------- */
async function syncCheckinToBackup() {
  try {
    const [mainResp, backupResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: MAIN_RANGE }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: BACKUP_RANGE })
    ]);
    const mainRows   = mainResp.data.values   || [];
    const backupRows = backupResp.data.values || [];

    const checkedRooms = new Set(
      mainRows.filter(r => (r[14] || '').trim() === '체크인').map(r => r[3])
    );
    const updates = [];
    backupRows.forEach((r, i) => {
      if (!checkedRooms.has(r[3])) return;
      if ((r[14] || '').trim() === '체크인') return;
      updates.push({
        range: `${sheetName}!O${41 + i}`,
        values: [['체크인']]
      });
    });
    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        resource: { valueInputOption: 'RAW', data: updates }
      });
      console.log(`[syncCheckinToBackup] ${updates.length}행 동기화`);
    }
  } catch (err) { console.error('[syncCheckinToBackup] 오류:', err); }
}
setInterval(() => syncCheckinToBackup().catch(console.error), 60_000);

/* ---------- hourlyDailyRefresh (5 분 간격) ------------------------------- */
async function hourlyDailyRefresh() {
  try {
    const dateName = todaySheetName();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId, fields: 'sheets.properties.title'
    });
    const exists = meta.data.sheets.some(s => s.properties.title === dateName);
    await createOrRefreshDailySheet(!exists);
  } catch (err) {
    console.error('[hourlyDailyRefresh] 오류:', err);
  }
}
hourlyDailyRefresh();
setInterval(() => hourlyDailyRefresh().catch(console.error), 300_000); // 5 분

//
// ------------------------------------------------------
// 11. Lazy Creator 미들웨어
// ------------------------------------------------------
app.use(async (req, _res, next) => {
  if (
    req.path === '/today-table' ||
    (req.path === '/daily-stats' && req.query.sheetName === todaySheetName())
  ) {
    await ensureTodaySheet();
  }
  next();
});

//
// ------------------------------------------------------
// 12. /config (스위치) ------------------------------------------------------
app.get('/config', async (_req, res) => {
  const { data: { values: [[v] = []] } = {} } =
    await sheets.spreadsheets.values.get({ spreadsheetId, range: CONFIG_RANGE });
  res.json({ auto: Number(v) || 0 });
});
app.post('/config', async (req, res) => {
  const val = Number(req.body.auto) ? 1 : 0;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: CONFIG_RANGE,
    valueInputOption: 'RAW',
    resource: { values: [[val]] }
  });
  res.json({ ok: true });
});

//
// ------------------------------------------------------
// 13. /search (PMS 조회 POST)
// ------------------------------------------------------
app.post('/search', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to)
    return res.status(400).send('체크인/체크아웃 날짜를 모두 입력하세요.');
  try {
    const data = await fetchPmsData(from, to);
    res.json(data);
  } catch (err) {
    console.error('스크래핑 오류:', err);
    res.status(500).send('스크래핑 오류:\n' + err.message);
  }
});

//
// ------------------------------------------------------
// 14. /sheet-data
// ------------------------------------------------------
app.get('/sheet-data', async (_req, res) => {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: MAIN_RANGE
    });
    res.json(resp.data.values || []);
  } catch (err) {
    console.error('시트데이터 조회 에러:', err);
    res.status(500).json([]);
  }
});

//
// ------------------------------------------------------
// 15. /daily-stats
// ------------------------------------------------------
app.get('/daily-stats', async (req, res) => {
  const { sheetName } = req.query;
  if (!sheetName) return res.status(400).json({ error: 'sheetName 파라미터 필요' });
  try {
    if (sheetName === todaySheetName()) await ensureTodaySheet();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${sheetName}!P1:Q2`
    });
    res.json({ stats: resp.data.values || [] });
  } catch (err) {
    console.error('날짜별 통계 오류:', err);
    res.status(500).json({ error: '시트 조회 실패' });
  }
});

//
// ------------------------------------------------------
// 16. /today-table
// ------------------------------------------------------
app.get('/today-table', async (_req, res) => {
  try {
    await ensureTodaySheet();
    const title = todaySheetName();
    const [headResp, bodyResp] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId, range: `${title}!A1:O1`
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId, range: `${title}!A2:O50`
      })
    ]);
    const header = headResp.data.values?.[0] ?? [];
    const rows = (bodyResp.data.values || []).map(r => ({
      values: r,
      checkedIn: (r[14] || '').trim() === '체크인'
    }));
    res.json({ header, rows });
  } catch (err) {
    console.error('today-table error:', err);
    res.status(500).json({ error: '오늘자 시트 로드 실패' });
  }
});

//
// ------------------------------------------------------
// 17. /upload (bulk 덮어쓰기)
// ------------------------------------------------------
app.post('/upload', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows))
    return res.status(400).send('전송할 데이터가 없습니다.');
  try {
    await uploadRows(rows);
    res.send('덮어쓰기 완료');
  } catch (err) {
    console.error('업로드 에러:', err);
    res.status(500).send('업로드 중 오류:\n' + err.message);
  }
});

//
// ------------------------------------------------------
// 18. /add (단일 추가)
// ------------------------------------------------------
app.post('/add', async (req, res) => {
  const {
    reservationDate, acct, bookingNumber, room, roomType, roomCount,
    checkInDate, duration, checkOutDate, adults, children,
    groupName, company, guestName, checkininfo
  } = req.body;
  const row = [
    reservationDate, acct, bookingNumber, room, roomType, roomCount,
    checkInDate, duration, checkOutDate, adults, children,
    groupName, company, guestName, checkininfo || '대기중'
  ];
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A2:O38`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] }
    });
    res.send('Record added successfully!');
  } catch (err) {
    console.error('Add error:', err);
    res.status(500).send('Failed to add record.');
  }
});

//
// ------------------------------------------------------
// 19. /search (게스트 검색 GET)
// ------------------------------------------------------
app.get('/search', async (req, res) => {
  const queryRaw = (req.query.query || '').trim().toLowerCase();
  const queryNorm = queryRaw.replace(/\s+/g, '');
  try {
    const [mainResp, backupResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: MAIN_RANGE }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: BACKUP_RANGE })
    ]);
    const mainRows   = mainResp.data.values   || [];
    const backupRows = (backupResp.data.values || []).map(r => r.slice(0, 15));

    const combined = [
      ...mainRows.map(r => ({ row: r, isMain: true })),
      ...backupRows.map(r => ({ row: r, isMain: false }))
    ];

    const filtered =
      combined.filter(item => {
        const row    = item.row.map(c => (c || '').toLowerCase());
        const exact  = row.some(c => c === queryRaw);
        const booking= (row[2] || '').includes(queryRaw);
        const nameRaw= (row[13] || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const parts  = nameRaw.split(' ');
        const direct = parts.join('');
        const rev    = parts.slice().reverse().join('');
        return exact || booking || direct.includes(queryNorm) || rev.includes(queryNorm);
      });

    const map = new Map();
    filtered.forEach(item => {
      const key = (item.row[13] || '').toLowerCase();
      if (!map.has(key) || (item.isMain && !map.get(key).isMain)) map.set(key, item);
    });

    const results = [...map.values()].map(i => i.row);
    if (!results.length) return res.json({ message: 'No record found' });

    const data = results.map(r => ({
      reservationDate : r[0] || '', reservationPlatform: r[1] || '',
      bookingNumber   : r[2] || '', room           : r[3] || '',
      roomType        : r[4] || '', roomCount      : r[5] || '',
      checkInDate     : formatDate8(r[6] || ''), duration: r[7] || '',
      checkOutDate    : formatDate8(r[8] || ''), adults  : r[9] || '',
      children        : r[10] || '', groupName     : r[11] || '',
      company         : r[12] || '', guestName     : r[13] || '',
      checkininfo     : r[14] || ''
    }));
    res.json({ message: 'Record found', data });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ message: 'Error during search' });
  }
});

//
// ------------------------------------------------------
// 20. /locker-info
// ------------------------------------------------------
app.get('/locker-info', async (_req, res) => {
  try {
    const [menResp, womenResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!U2:V19` }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!X2:Y21` })
    ]);
    const locker_room_men      = [], locker_password_men = [];
    const locker_room_women    = [], locker_password_women = [];
    (menResp.data.values || []).forEach(r => {
      locker_room_men.push(r[0] || ''); locker_password_men.push(r[1] || '');
    });
    (womenResp.data.values || []).forEach(r => {
      locker_room_women.push(r[0] || ''); locker_password_women.push(r[1] || '');
    });
    res.json({
      locker_room_men, locker_password_men,
      locker_room_women, locker_password_women
    });
  } catch (err) {
    console.error('Locker-info error:', err);
    res.status(500).json({ message: 'Failed to load locker info' });
  }
});

//
// ------------------------------------------------------
// 21. /capture-screenshot
// ------------------------------------------------------
app.post('/capture-screenshot', async (req, res) => {
  const { url } = req.body;
  const browser = await puppeteer.launch();
  const page    = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  const shot = path.join(__dirname, 'reservation_info.png');
  await page.screenshot({ path: shot, fullPage: true });
  await browser.close();
  res.sendFile(shot, err => {
    if (err) console.error(err);
    else fs.unlink(shot, () => {});
  });
});

//
// ------------------------------------------------------
// 22. /contact-info
// ------------------------------------------------------
app.get('/contact-info', async (req, res) => {
  const type = req.query.type;
  let range;
  switch (type) {
    case 'phone':   range = 'P2:P2'; break;
    case 'email':   range = 'Q2:Q2'; break;
    case 'wechat':  range = 'R2:R2'; break;
    case 'whatsapp':range = 'S2:S2'; break;
    default:
      return res.status(400).json({ error: 'Invalid type' });
  }
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${sheetName}!${range}`
    });
    res.json({ value: resp.data.values?.[0]?.[0] || null });
  } catch (err) {
    console.error('Contact-info error:', err);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

//
// ------------------------------------------------------
// 23. /banner-info
// ------------------------------------------------------
app.get('/banner-info', async (_req, res) => {
  try {
    const [imgResp, linkResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!P6:P15` }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!Q6:Q15` })
    ]);
    const images = imgResp.data.values || [];
    const links  = linkResp.data.values || [];
    const banner = [];
    const len    = Math.min(images.length, links.length);
    for (let i = 0; i < len; i++) {
      let url = images[i][0];
      const m = url.match(/\/d\/([A-Za-z0-9_-]+)\//);
      if (m) url = `https://drive.google.com/uc?export=view&id=${m[1]}`;
      banner.push({
        image: `/image-proxy?url=${encodeURIComponent(url)}`,
        link : links[i][0]
      });
    }
    res.json(banner);
  } catch (err) {
    console.error('Banner-info error:', err);
    res.status(500).json({ error: 'Failed to load banner info' });
  }
});

//
// ------------------------------------------------------
// 24. /image-proxy
// ------------------------------------------------------
app.get('/image-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('url 파라미터 필요');
  try {
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).send('이미지 로드 실패');
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.set('Access-Control-Allow-Origin', '*');
    response.body.pipe(res);
  } catch (err) {
    console.error('Image-proxy error:', err);
    res.status(500).send('이미지 프록시 오류');
  }
});

//
// ------------------------------------------------------
// 25. /checkin
// ------------------------------------------------------
app.post('/checkin', async (req, res) => {
  const { bookingNumber } = req.body;
  if (!bookingNumber) return res.status(400).send('bookingNumber 필요');
  try {
    const resp   = await sheets.spreadsheets.values.get({ spreadsheetId, range: MAIN_RANGE });
    const values = resp.data.values || [];
    const idx    = values.findIndex(r => r[2] === bookingNumber);
    if (idx === -1) return res.status(404).send('예약 정보를 찾을 수 없습니다.');

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!O${idx + 2}`,
      valueInputOption: 'RAW',
      resource: { values: [['체크인']] }
    });
    res.send('체크인 처리되었습니다.');
  } catch (err) {
    console.error('체크인 처리 오류:', err);
    res.status(500).send('체크인 처리 중 오류 발생');
  }
});

//
// ------------------------------------------------------
// 26. node-cron 자동 업로드  (workDateStr 사용)
// ------------------------------------------------------
let cronRunning = false;

const CRON_EXPR = '* * * * *';    // 매 분

cron.schedule(
  CRON_EXPR,
  async () => {
    if (cronRunning) return;
    cronRunning = true;
    try {
      /* ① 스위치 확인 */
      const { data: { values: [[flag] = []] } = {} } =
        await sheets.spreadsheets.values.get({ spreadsheetId, range: CONFIG_RANGE });
      if (Number(flag) !== 1) return;

      /* ② 업무-기준일 PMS 조회 */
      const workDay = workDateStr();        // ★ 11 시 컷오프 반영
      const rowsObj = await fetchPmsData(workDay, workDay);
      if (!rowsObj.length) return;

      /* ③ 업로드 */
      const rows2D = rowsObj.map(r => HEADERS.map(h => r[h] || ''));
      await uploadRows(rows2D);

      console.log('[AUTO-CRON] Upload ✅', kstNow().toLocaleString('ko-KR'));
    } catch (err) {
      console.error('[AUTO-CRON] Error:', err);
    } finally {
      cronRunning = false;
    }
  },
  { timezone: 'Asia/Seoul' }
);

//
// ------------------------------------------------------
// 27. batchCheckin & /auto-checkin  (동일 로직, 변경 없음)
// ------------------------------------------------------
async function batchCheckin(from, to) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false, slowMo: 35, args: ['--no-sandbox']
    });
    const page = await browser.newPage();

    /* 1) 로그인 */
    await page.goto('https://82capsule.oapms.co.kr/', { waitUntil: 'networkidle2' });
    await page.type('#id.login_inp.login_inp01', '82capsule');
    await page.type('#password.login_inp.login_inp02', '1');
    await Promise.all([
      page.click('#loginBtn.login_btn'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    /* 2) 기간 검색 */
    await page.goto(
      'https://82capsule.oapms.co.kr/kor/fo/reve/RoomReveSearchFrm',
      { waitUntil: 'networkidle2' }
    );
    await page.waitForSelector('#reve_tran_adat_from');
    await page.evaluate((f, t) => {
      document.getElementById('reve_tran_adat_from').value = f;
      document.getElementById('reve_tran_adat_to').value   = t;
    }, from, to);
    await page.click('#btnSearch');
    await page.waitForSelector('tr.reveRow');

    /* 3) RACNO 수집 */
    const racnos = await page.$$eval(
      'tr.reveRow input[name="reve_tran_acno"]',
      els => els.map(e => e.value.trim()).filter(Boolean)
    );
    console.log('RACNOs:', racnos);

    /* 4) 상세 페이지 루프 */
    for (const racno of racnos) {
      console.log('▶ CHECK-IN 시도', racno);

      // --- 상세 진입
      await page.goto(
        `https://82capsule.oapms.co.kr/kor/fo/reve/RoomReveFrm?racno=${racno}&rseq=1`,
        { waitUntil: 'networkidle2' }
      );

      // --- 현재 frame
      let frame = page.frames().find(f => f.url().includes('RoomReveFrm'));
      if (!frame) {
        console.error('  ✖ frame 없음', racno);
        await page.screenshot({ path: `fail-${racno}-noframe.png` });
        continue;
      }

      // --- 드롭다운 선택
      try {
        await frame.waitForSelector('select[name="reve_tran_stau"]', { timeout: 5_000 });
        await frame.click('select[name="reve_tran_stau"]');   // 포커스
        await frame.evaluate(() => {
          const sel = document.querySelector('select[name="reve_tran_stau"]');
          const opt =
            [...sel.options].find(o => /CHECK\s*IN/i.test(o.textContent));
          if (!opt) throw new Error('CHECK IN option not found');
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } catch (e) {
        console.error('  ✖ 드롭다운 오류', racno, e.message);
        await page.screenshot({ path: `fail-${racno}-select.png` });
        continue;
      }

      // --- 저장 버튼 찾기 (리로드가 일어나면 frame 갱신)
      const nav = page
        .waitForNavigation({ waitUntil: 'networkidle0', timeout: 10_000 })
        .catch(() => null);
      await nav;  // reload 발생 시까지(최대 10s)

      frame = page.frames().find(f => f.url().includes('RoomReveFrm')) ||
              (frame.isDetached() ? null : frame);

      if (!frame) {
        console.error('  ✖ frame 재확보 실패', racno);
        await page.screenshot({ path: `fail-${racno}-detached.png` });
        continue;
      }

      const saveBtn = await (frame.$('#btnSave') || page.$('#btnSave'));

      // --- 저장 버튼이 있으면 클릭, 없으면 이미 저장된 것으로 간주
      if (saveBtn) {
        page.once('dialog', d => d.accept().catch(() => {}));
        const nav2 = page
          .waitForNavigation({ waitUntil: 'load', timeout: 10_000 })
          .catch(() => null);
        await saveBtn.click();
        await nav2;
      }

      console.log('  ✓ 완료', racno);
    }

    return { done: racnos.length };
  } finally {
    if (browser) await browser.close();
  }
}

/* /auto-checkin 라우트 */
app.post('/auto-checkin', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).send('날짜 필요');
  try {
    const result = await batchCheckin(from, to);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[AUTO-CHECKIN] 오류:', err);
    res.status(500).send('자동 체크인 오류:\n' + err.message);
  }
});

//
// ------------------------------------------------------
// 28. 서버 시작
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
