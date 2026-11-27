/**
 * ============================================================================
 *  KELAS MEMBACA — CMS & LMS Literasi · Google Apps Script REST API
 *  Versi 5.0.0  (Smart Reading Tracker · Kelas Batch 30 Hari · Kolaborasi)
 * ============================================================================
 *  PENGGUNAAN SINGKAT (panduan lengkap ada di file panduan):
 *   1. Buat Google Spreadsheet kosong. Salin ID-nya (antara "/d/" dan "/edit").
 *   2. Extensions > Apps Script, tempel seluruh isi file ini ke Code.gs.
 *   3. Project Settings > Script Properties (opsional):
 *        SPREADSHEET_ID  = ID spreadsheet (jika tidak diisi, memakai default)
 *        ADMIN_EMAILS    = email mentor, dipisah koma (akun ini otomatis Admin)
 *        MAIL_NAME       = nama pengirim email reset kata sandi (opsional)
 *   4. Jalankan setupDatabase() sekali dan setujui izin (Sheets, Drive, Gmail).
 *   5. Deploy > New deployment > Web app
 *        Execute as: Me   |   Who has access: Anyone
 *   6. Salin URL berakhiran /exec ke CFG.API_URL pada tema Blogger
 *        (Tema > Edit HTML, ganti teks REPLACE_WITH_DEPLOYMENT_ID).
 *   7. (Opsional) Jalankan kmInstallDailyTrigger() agar kelas batch yang sudah
 *      lewat tanggal berakhir otomatis dievaluasi dan dipindah ke Kelas Alumni.
 *
 *  KOMPATIBILITAS: seluruh nama aksi dan bentuk respons dari versi 4.x tetap
 *  dipertahankan, sehingga aplikasi lama tetap dapat berjalan. Aksi baru:
 *  uploadBookCover, deleteBookCover, requestPasswordReset,
 *  confirmPasswordReset, generateClassTasks, runLifecycle, importAllData.
 * ============================================================================
 */

const KM_CONFIG = Object.freeze({
  VERSION: '5.0.0',
  APP_NAME: 'Kelas Membaca',
  DEFAULT_SPREADSHEET_ID: '1jBFonTOZkHlHgRrwe0CMl1Ys41oxM1wddlhlShaCDuo',
  TIMEZONE: 'Asia/Jakarta',
  SESSION_TTL_SECONDS: 21600,            // 6 jam (batas maksimum CacheService)
  MAX_PAYLOAD_BYTES: 6 * 1024 * 1024,    // 6 MB (termasuk sampul base64)
  MAX_COVER_BYTES: 3 * 1024 * 1024,      // 3 MB per sampul
  SCHEMA_CACHE_KEY: 'km-schema-v5',
  COVER_FOLDER_NAME: 'Kelas Membaca - Sampul Buku',
  RESET_CODE_TTL: 900,                   // kode reset berlaku 15 menit
  RESET_MAX_ATTEMPTS: 5,
  DAILY_TARGET_PAGES: 35,
  BATCH_DAYS: 30,
  RATE_LIMIT: {
    LOGIN_MAX: 10, LOGIN_WINDOW: 900,
    REGISTER_MAX: 5, REGISTER_WINDOW: 3600,
    RESET_MAX: 5, RESET_WINDOW: 3600
  },
  TABLES: {
    Users: [
      'UserID', 'Name', 'Username', 'Email', 'PasswordHash', 'PasswordSalt',
      'Role', 'JoinDate', 'AlumniJoinDate', 'WaSettings', 'AvatarURL', 'Bio',
      'ResetToken', 'AuthVersion', 'UpdatedAt'
    ],
    Friends: ['FriendID', 'UserID', 'FriendUserID', 'Status', 'CreatedAt'],
    ReadingBooks: [
      'BookID', 'UserID', 'Title', 'Author', 'TotalPages', 'CurrentPage',
      'CoverURL', 'CoverFileID', 'Topic', 'Status', 'LastReadAt', 'CreatedAt', 'UpdatedAt'
    ],
    ReadingLogs: [
      'LogID', 'UserID', 'BookID', 'ClassID', 'Date', 'StartTime', 'EndTime',
      'BookTitle', 'Author', 'TotalBookPages', 'CoverURL', 'StartPage', 'EndPage',
      'PagesRead', 'TotalMinutes', 'EffectiveMinutes', 'Insight', 'Topic',
      'IsPublic', 'CreatedAt', 'UpdatedAt'
    ],
    Comments: ['CommentID', 'LogID', 'UserID', 'CommentText', 'CreatedAt'],
    Classes: [
      'ClassID', 'ClassName', 'BatchNumber', 'ClassType', 'Description', 'MentorName',
      'StartDate', 'EndDate', 'CloseDate', 'TargetPagesPerDay', 'MinGradTasks',
      'MinGradPages', 'Status', 'CreatedAt', 'UpdatedAt'
    ],
    ClassMembers: [
      'EnrollmentID', 'ClassID', 'UserID', 'JoinDate', 'BatchPagesRead',
      'BatchTasksCompleted', 'GraduationStatus', 'GraduatedAt', 'MigratedToAlumniAt'
    ],
    Tasks: [
      'TaskID', 'ClassID', 'TaskNumber', 'Title', 'Description', 'ActiveDate', 'Deadline',
      'FormJSON', 'ValidationRuleJSON', 'Status', 'CreatedAt', 'UpdatedAt'
    ],
    UserTasks: [
      'UserTaskID', 'UserID', 'TaskID', 'Status', 'AnswersJSON', 'Feedback',
      'Score', 'SubmittedAt', 'ReviewedAt'
    ]
  }
});

/** Aksi yang mengubah data (dijalankan di dalam LockService). */
const KM_WRITE_ACTIONS = Object.freeze({
  register: true, requestPasswordReset: false, confirmPasswordReset: true,
  saveUser: true, deleteUser: true, saveReadingBook: true, deleteReadingBook: true,
  uploadBookCover: true, deleteBookCover: true, saveLog: true, deleteLog: true,
  addComment: true, deleteComment: true, toggleFriend: true, saveClass: true,
  deleteClass: true, joinClass: true, generateClassTasks: true, saveTask: true,
  deleteTask: true, submitTask: true, reviewSubmission: true, updateProfile: true,
  changePassword: true, runLifecycle: true, importAllData: true
});

/** Kerangka 10 tugas terjadwal otomatis (offset hari dari tanggal mulai batch). */
const KM_TASK_BLUEPRINT = Object.freeze([
  { type: 'onboarding', title: 'Perkenalan & Komitmen Membaca', offset: 0,
    description: 'Perkenalkan dirimu, tujuan membacamu, dan buku pertama yang akan kamu mulai.',
    form: [
      { id: 'nama', label: 'Nama panggilan', type: 'text', required: true },
      { id: 'tujuan', label: 'Tujuan membaca selama batch ini', type: 'textarea', required: true },
      { id: 'buku', label: 'Buku pertama yang akan dibaca', type: 'text', required: false }
    ] },
  { type: 'social_photo', title: 'Foto Momen Membaca', offset: 3,
    description: 'Bagikan satu foto momen membacamu beserta caption singkat.',
    form: [
      { id: 'foto', label: 'Link foto momenmu', type: 'url', required: true },
      { id: 'caption', label: 'Caption singkat', type: 'textarea', required: true }
    ] },
  { type: 'handwriting', title: 'Catatan Tulis Tangan', offset: 6,
    description: 'Tulis satu kutipan dari bacaanmu dengan tangan, lalu unggah fotonya.',
    form: [
      { id: 'foto', label: 'Link foto tulisan tanganmu', type: 'url', required: true },
      { id: 'kutipan', label: 'Kutipan yang kamu tulis', type: 'textarea', required: true }
    ] },
  { type: 'reading_category', title: 'Kategori Bacaan', offset: 9,
    description: 'Pilih kategori bacaanmu dan jelaskan alasannya.',
    form: [
      { id: 'kategori', label: 'Kategori bacaan', type: 'select', required: true,
        options: ['Pengembangan Diri', 'Bisnis & Ekonomi', 'Sains & Teknologi', 'Fiksi', 'Sejarah', 'Agama & Spiritual', 'Lainnya'] },
      { id: 'alasan', label: 'Mengapa memilih kategori ini?', type: 'textarea', required: true }
    ] },
  { type: 'reading_book', title: 'Ulasan Satu Buku', offset: 12,
    description: 'Tulis ulasan singkat satu buku yang sudah kamu baca.',
    form: [
      { id: 'judul', label: 'Judul buku', type: 'text', required: true },
      { id: 'penulis', label: 'Nama penulis', type: 'text', required: true },
      { id: 'ulasan', label: 'Ulasan singkat', type: 'textarea', required: true }
    ] },
  { type: 'reading_pages', title: 'Target 35 Halaman Pertama', offset: 15,
    description: 'Laporkan jumlah halaman yang kamu baca pada pekan ini.',
    validationRule: { type: 'reading_pages', minPages: 35 },
    form: [
      { id: 'halaman', label: 'Jumlah halaman yang dibaca', type: 'number', required: true },
      { id: 'refleksi', label: 'Refleksi singkat', type: 'textarea', required: true }
    ] },
  { type: 'review', title: 'Review Tengah Batch', offset: 18,
    description: 'Tinjau kemajuanmu sejauh ini dan tentukan langkah berikutnya.',
    form: [
      { id: 'review', label: 'Review bacaanmu minggu ini', type: 'textarea', required: true },
      { id: 'rating', label: 'Penilaian diri (1-5)', type: 'select', required: true, options: ['1', '2', '3', '4', '5'] }
    ] },
  { type: 'story', title: 'Cerita Membaca', offset: 21,
    description: 'Ceritakan pengalaman membacamu yang paling berkesan.',
    form: [
      { id: 'cerita', label: 'Ceritakan pengalaman membacamu', type: 'textarea', required: true }
    ] },
  { type: 'reading_pages', title: 'Target 35 Halaman Kedua', offset: 24,
    description: 'Laporkan kembali jumlah halaman yang kamu baca dan refleksinya.',
    validationRule: { type: 'reading_pages', minPages: 35 },
    form: [
      { id: 'halaman', label: 'Jumlah halaman yang dibaca', type: 'number', required: true },
      { id: 'refleksi', label: 'Refleksi singkat', type: 'textarea', required: true }
    ] },
  { type: 'review', title: 'Rangkuman Akhir Batch', offset: 27,
    description: 'Rangkum seluruh perjalanan membacamu selama satu batch.',
    form: [
      { id: 'rangkuman', label: 'Rangkuman perjalananmu', type: 'textarea', required: true },
      { id: 'pelajaran', label: 'Pelajaran terbesar', type: 'textarea', required: true }
    ] }
]);

/** Cache isi tabel selama satu eksekusi request (dihapus setiap request). */
var _kmCache = null;
var _kmSpreadsheet = null;

/* ==========================================================================
 * ENTRY POINTS
 * ========================================================================== */

/** Seluruh request mutasi dan query dari aplikasi (POST, body JSON text/plain). */
function doPost(e) {
  _kmCache = {};
  _kmSpreadsheet = null;
  var request;
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    if (raw.length > KM_CONFIG.MAX_PAYLOAD_BYTES) {
      return km_output_(km_respond_(false, 'Payload permintaan terlalu besar (maks 6 MB).', null, 'PAYLOAD_TOO_LARGE'));
    }
    request = JSON.parse(raw);
  } catch (error) {
    return km_output_(km_respond_(false, 'Format JSON permintaan tidak valid.', null, 'INVALID_JSON'));
  }
  return km_output_(km_handle_(request));
}

/** GET untuk health check dan katalog publik (Landing Page). */
function doGet(e) {
  _kmCache = {};
  _kmSpreadsheet = null;
  var params = e && e.parameter ? e.parameter : {};
  var action = String(params.action || 'health');
  var response;
  try {
    if (action === 'health') {
      response = km_respond_(true, 'Kelas Membaca API v' + KM_CONFIG.VERSION + ' siap melayani.', {
        version: KM_CONFIG.VERSION, status: 'online', app: KM_CONFIG.APP_NAME
      });
    } else if (action === 'publicCatalog') {
      km_ensureDatabase_();
      response = km_respond_(true, 'Katalog bacaan komunitas berhasil dimuat.', km_publicCatalog_());
    } else {
      response = km_respond_(false, 'Endpoint GET hanya mendukung action health dan publicCatalog.', null, 'METHOD_NOT_ALLOWED');
    }
  } catch (error) {
    response = km_fail_(error);
  }
  return km_output_(response);
}

/** Jalankan sekali dari editor Apps Script untuk menyiapkan tabel dan folder Drive. */
function setupDatabase() {
  CacheService.getScriptCache().remove(KM_CONFIG.SCHEMA_CACHE_KEY);
  _kmCache = {};
  km_ensureDatabase_();
  km_coverFolder_();
  return 'Database Kelas Membaca v' + KM_CONFIG.VERSION + ' siap: ' + Object.keys(KM_CONFIG.TABLES).join(', ');
}

/** Pasang trigger harian untuk evaluasi batch & migrasi ke Kelas Alumni. */
function kmInstallDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'kmDailyLifecycleTrigger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('kmDailyLifecycleTrigger').timeBased().everyDays(1).atHour(0).create();
  return 'Trigger harian aktif. Evaluasi batch berjalan sekitar pukul 00.00 waktu skrip.';
}

function kmDailyLifecycleTrigger() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    _kmCache = {};
    _kmSpreadsheet = null;
    km_ensureDatabase_();
    km_runLifecycle_(null);
  } finally {
    lock.releaseLock();
  }
}

/* ==========================================================================
 * ROUTER
 * ========================================================================== */

function km_handle_(request) {
  try {
    if (!request || typeof request !== 'object') {
      throw km_err_('INVALID_REQUEST', 'Format permintaan tidak valid.');
    }
    var action = String(request.action || '').trim();
    if (!action) throw km_err_('MISSING_ACTION', 'Parameter action belum ditentukan.');

    if (action !== 'health') km_ensureDatabase_();

    if (KM_WRITE_ACTIONS[action]) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) {
        throw km_err_('BUSY', 'Server sedang memproses data lain. Coba lagi beberapa detik.');
      }
      try {
        _kmCache = {};
        return km_ok_(km_route_(action, request));
      } finally {
        lock.releaseLock();
      }
    }
    return km_ok_(km_route_(action, request));
  } catch (error) {
    return km_fail_(error);
  }
}

function km_route_(action, request) {
  var data = request.data && typeof request.data === 'object' ? request.data : {};

  if (action === 'health') return { version: KM_CONFIG.VERSION, status: 'online' };
  if (action === 'publicCatalog') return km_publicCatalog_();
  if (action === 'register') return km_register_(data);
  if (action === 'login') return km_login_(data);
  if (action === 'logout') return km_logout_(request);
  if (action === 'requestPasswordReset') return km_requestPasswordReset_(data);
  if (action === 'confirmPasswordReset') return km_confirmPasswordReset_(data);

  var user = km_requireUser_(request);

  switch (action) {
    case 'getDashboard': return km_dashboard_(user);
    case 'updateProfile': return km_updateProfile_(user, data);
    case 'changePassword': return km_changePassword_(user, data);
    case 'exportAllData': return km_exportAllData_(user);
    case 'importAllData': return km_importAllData_(user, data);
    case 'saveReadingBook': return km_saveReadingBook_(user, data);
    case 'deleteReadingBook': return km_deleteReadingBook_(user, data);
    case 'uploadBookCover': return km_uploadBookCover_(user, data);
    case 'deleteBookCover': return km_deleteBookCover_(user, data);
    case 'saveLog': return km_saveLog_(user, data);
    case 'deleteLog': return km_deleteLog_(user, data);
    case 'getBookTimeline': return km_bookTimeline_(user, data);
    case 'addComment': return km_addComment_(user, data);
    case 'deleteComment': return km_deleteComment_(user, data);
    case 'toggleFriend': return km_toggleFriend_(user, data);
    case 'getUserBookshelf': return km_userBookshelf_(user, data);
    case 'listClasses': return km_listClasses_(user);
    case 'saveClass': return km_saveClass_(user, data);
    case 'deleteClass': return km_deleteClass_(user, data);
    case 'joinClass': return km_joinClass_(user, data);
    case 'listClassMembers': return km_listClassMembers_(user, data);
    case 'leaderboard': return km_leaderboard_(user, data);
    case 'generateClassTasks': return km_generateClassTasks_(user, data);
    case 'listTasks': return km_listTasks_(user);
    case 'saveTask': return km_saveTask_(user, data);
    case 'deleteTask': return km_deleteTask_(user, data);
    case 'submitTask': return km_submitTask_(user, data);
    case 'listTaskSubmissions': return km_listTaskSubmissions_(user, data);
    case 'reviewSubmission': return km_reviewSubmission_(user, data);
    case 'listUsers': return km_listUsers_(user, data);
    case 'saveUser': return km_saveUser_(user, data);
    case 'deleteUser': return km_deleteUser_(user, data);
    case 'getMemberProgress': return km_memberProgress_(user, data);
    case 'runLifecycle': return km_runLifecycle_(user);
    case 'impersonateUser': return km_impersonate_(user, data);
    default:
      throw km_err_('UNKNOWN_ACTION', 'Aksi API tidak dikenali: ' + action);
  }
}

/* ==========================================================================
 * RESPONSE & ERROR HELPERS
 * ========================================================================== */

function km_output_(response) {
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function km_respond_(success, message, data, code) {
  var payload = {
    success: Boolean(success),
    message: String(message || ''),
    data: data === undefined ? null : data,
    timestamp: new Date().toISOString()
  };
  if (code) payload.code = code;
  return payload;
}

function km_ok_(result) {
  var message = result && result._message ? result._message : 'Berhasil.';
  var data = result;
  if (result && typeof result === 'object' && result._message !== undefined) {
    data = Object.assign({}, result);
    delete data._message;
  }
  return km_respond_(true, message, data);
}

function km_fail_(error) {
  try {
    console.error('[KM-API] ' + ((error && error.stack) || (error && error.message) || String(error)));
  } catch (e) { /* noop */ }
  var message = error && error.message ? error.message : 'Terjadi kesalahan pada server.';
  var code = error && error.apiCode ? error.apiCode : 'SERVER_ERROR';
  return km_respond_(false, message, null, code);
}

function km_err_(code, message) {
  var err = new Error(message);
  err.apiCode = code;
  return err;
}

/* ==========================================================================
 * DATABASE LAYER (SPREADSHEET ≙ TABEL)
 * ========================================================================== */

function km_spreadsheet_() {
  if (_kmSpreadsheet) return _kmSpreadsheet;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || KM_CONFIG.DEFAULT_SPREADSHEET_ID;
  if (!id) throw km_err_('CONFIG', 'SPREADSHEET_ID belum diatur pada Script Properties.');
  try {
    _kmSpreadsheet = SpreadsheetApp.openById(id);
  } catch (error) {
    throw km_err_('SPREADSHEET_ACCESS', 'Spreadsheet tidak dapat diakses. Pastikan SPREADSHEET_ID benar dan akun memiliki izin edit.');
  }
  return _kmSpreadsheet;
}

function km_ensureDatabase_() {
  var cache = CacheService.getScriptCache();
  if (cache.get(KM_CONFIG.SCHEMA_CACHE_KEY) === 'ready') return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw km_err_('BUSY', 'Sedang memvalidasi struktur database. Coba sesaat lagi.');
  try {
    if (cache.get(KM_CONFIG.SCHEMA_CACHE_KEY) === 'ready') return;
    var ss = km_spreadsheet_();
    Object.keys(KM_CONFIG.TABLES).forEach(function (tableName) {
      var expected = KM_CONFIG.TABLES[tableName];
      var sheet = ss.getSheetByName(tableName) || ss.insertSheet(tableName);
      var lastCol = sheet.getLastColumn();
      var current = lastCol > 0
        ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); })
        : [];
      while (current.length && !current[current.length - 1]) current.pop();

      if (!current.length) {
        sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
      } else {
        var missing = expected.filter(function (h) { return current.indexOf(h) === -1; });
        if (missing.length) {
          sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
        }
      }
      sheet.getRange(1, 1, 1, expected.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
      // Kolom berisi teks (tanggal, nomor WA, hash) disimpan sebagai teks agar tidak diubah Sheets.
      var rows = Math.max(sheet.getMaxRows() - 1, 1);
      sheet.getRange(2, 1, rows, expected.length).setNumberFormat('@');
    });
    cache.put(KM_CONFIG.SCHEMA_CACHE_KEY, 'ready', 21600);
  } finally {
    lock.releaseLock();
  }
}

function km_sheet_(name) {
  var sheet = km_spreadsheet_().getSheetByName(name);
  if (!sheet) throw km_err_('SCHEMA', 'Tabel ' + name + ' belum ada. Jalankan setupDatabase().');
  return sheet;
}

function km_formatCell_(val) {
  if (val instanceof Date) {
    var tz = KM_CONFIG.TIMEZONE;
    var base = Utilities.formatDate(val, tz, "yyyy-MM-dd'T'HH:mm:ss");
    return base + '+07:00';
  }
  return val;
}

function km_readSheet_(sheet) {
  if (!sheet) return [];
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  if (!lastCol || lastRow < 2) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];
  values.forEach(function (row) {
    if (!row.some(function (cell) { return cell !== '' && cell !== null; })) return;
    var obj = {};
    headers.forEach(function (h, idx) { if (h) obj[h] = km_formatCell_(row[idx]); });
    out.push(obj);
  });
  return out;
}

/** Membaca beberapa tabel sekaligus (memakai cache per request). */
function km_readTables_(names) {
  if (!_kmCache) _kmCache = {};
  names.forEach(function (name) {
    if (!Object.prototype.hasOwnProperty.call(_kmCache, name)) {
      _kmCache[name] = km_readSheet_(km_spreadsheet_().getSheetByName(name));
    }
  });
  var out = {};
  names.forEach(function (n) { out[n] = _kmCache[n] || []; });
  return out;
}

function km_readTable_(name) {
  return km_readTables_([name])[name];
}

function km_invalidate_(name) {
  if (_kmCache) delete _kmCache[name];
}

/** Menyimpan (insert/update) satu record berdasarkan kolom kunci. */
function km_saveRecord_(tableName, keyField, record) {
  var sheet = km_sheet_(tableName);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var keyIdx = headers.indexOf(keyField);
  var lastRow = sheet.getLastRow();
  var raw = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  var matchIndex = -1;
  var existing = {};
  for (var i = 0; i < raw.length; i++) {
    if (String(raw[i][keyIdx]) === String(record[keyField])) {
      matchIndex = i;
      headers.forEach(function (h, idx) { if (h) existing[h] = km_formatCell_(raw[i][idx]); });
      break;
    }
  }
  var merged = Object.assign({}, existing, record);
  var outRow = headers.map(function (h) {
    return merged[h] === undefined || merged[h] === null ? '' : merged[h];
  });
  var targetRow = matchIndex >= 0 ? matchIndex + 2 : Math.max(2, lastRow + 1);
  sheet.getRange(targetRow, 1, 1, lastCol).setValues([outRow]);
  km_invalidate_(tableName);
  return merged;
}

/** Menyimpan banyak record sekaligus dalam satu penulisan (insert/update, tanpa hapus). */
function km_upsertMany_(tableName, keyField, records) {
  if (!records.length) return 0;
  var sheet = km_sheet_(tableName);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var keyIdx = headers.indexOf(keyField);
  var lastRow = sheet.getLastRow();
  var matrix = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var index = {};
  matrix.forEach(function (row, i) { index[String(row[keyIdx])] = i; });

  records.forEach(function (rec) {
    var key = String(rec[keyField]);
    var rowObj = index.hasOwnProperty(key) ? matrix[index[key]] : null;
    var base = {};
    if (rowObj) headers.forEach(function (h, idx) { if (h) base[h] = km_formatCell_(rowObj[idx]); });
    var merged = Object.assign({}, base, rec);
    var out = headers.map(function (h) {
      return merged[h] === undefined || merged[h] === null ? '' : merged[h];
    });
    if (rowObj) {
      matrix[index[key]] = out;
    } else {
      matrix.push(out);
      index[key] = matrix.length - 1;
    }
  });
  if (matrix.length) {
    sheet.getRange(2, 1, matrix.length, lastCol).setValues(matrix);
  }
  km_invalidate_(tableName);
  return records.length;
}

/** Menghapus baris yang memenuhi predikat. Mengembalikan jumlah baris terhapus. */
function km_deleteWhere_(tableName, predicate) {
  var sheet = km_sheet_(tableName);
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  if (!lastCol || lastRow < 2) return 0;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var keep = [];
  var deleted = 0;
  rows.forEach(function (row) {
    var record = {};
    headers.forEach(function (h, idx) { if (h) record[h] = km_formatCell_(row[idx]); });
    if (predicate(record)) deleted++;
    else keep.push(row);
  });
  if (deleted > 0) {
    sheet.getRange(2, 1, rows.length, lastCol).clearContent();
    if (keep.length) sheet.getRange(2, 1, keep.length, lastCol).setValues(keep);
    km_invalidate_(tableName);
  }
  return deleted;
}

/* ==========================================================================
 * UTILITAS UMUM
 * ========================================================================== */

function km_id_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 18);
}

function km_now_() {
  return new Date().toISOString();
}

function km_todayWIB_() {
  return Utilities.formatDate(new Date(), KM_CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function km_addDays_(dateStr, n) {
  var d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function km_dateOnly_(val) {
  var text = String(val || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function km_safeDate_(val, fallback) {
  var d = km_dateOnly_(val);
  return d || (fallback === undefined ? km_todayWIB_() : fallback);
}

function km_clean_(val, maxLen) {
  return String(val === undefined || val === null ? '' : val)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen || 4000);
}

function km_email_(val) {
  return km_clean_(val, 180).toLowerCase();
}

function km_validEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function km_username_(val, fallbackName) {
  var raw = km_clean_(val || fallbackName || 'pembaca', 40).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return raw || 'pembaca';
}

function km_isTrue_(val) {
  return val === true || String(val).toLowerCase() === 'true' || String(val) === '1';
}

function km_isPublic_(log) {
  return (log.IsPublic === undefined || log.IsPublic === null || log.IsPublic === '')
    ? true
    : km_isTrue_(log.IsPublic);
}

function km_parseJson_(val, fallback) {
  try {
    if (typeof val === 'string') return val ? JSON.parse(val) : fallback;
    return val === undefined || val === null || val === '' ? fallback : val;
  } catch (e) {
    return fallback;
  }
}

function km_num_(val, min, max, fallback) {
  var num = Number(val);
  if (!isFinite(num)) num = fallback === undefined ? 0 : fallback;
  return Math.max(min, Math.min(max, num));
}

/** Hanya URL https yang disimpan (sampul Drive, tautan eksternal). Data URI tidak disimpan di sel. */
function km_safeUrl_(val) {
  var url = km_clean_(val, 2000);
  if (!url) return '';
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function km_salt_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function km_hash_(text, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + ':' + String(text), Utilities.Charset.UTF_8);
  return digest.map(function (b) {
    var hex = (b < 0 ? b + 256 : b).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

function km_validatePassword_(password) {
  var p = String(password || '');
  if (p.length < 8 || p.length > 128) {
    throw km_err_('VALIDATION', 'Kata sandi harus terdiri dari 8 hingga 128 karakter.');
  }
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) {
    throw km_err_('VALIDATION', 'Kata sandi harus mengandung minimal 1 huruf dan 1 angka.');
  }
}

function km_rateLimit_(key, maxAttempts, windowSec) {
  var cache = CacheService.getScriptCache();
  var now = Date.now();
  var bucket = null;
  try { bucket = JSON.parse(cache.get(key) || 'null'); } catch (e) { bucket = null; }
  if (!bucket || typeof bucket.count !== 'number' || typeof bucket.resetAt !== 'number' || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowSec * 1000 };
  }
  if (bucket.count >= maxAttempts) {
    throw km_err_('RATE_LIMITED', 'Terlalu banyak percobaan. Silakan coba beberapa saat lagi.');
  }
  bucket.count += 1;
  cache.put(key, JSON.stringify(bucket), Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
}

function km_clearRateLimit_(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) { /* noop */ }
}

function km_adminEmails_() {
  var raw = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  return raw.split(/[;,\s]+/).map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
}

function km_isAdmin_(user) {
  return !!user && String(user.Role || '').toLowerCase() === 'admin';
}

function km_requireAdmin_(user) {
  if (!km_isAdmin_(user)) {
    throw km_err_('FORBIDDEN', 'Aksi ini hanya dapat dilakukan oleh Administrator / Mentor.');
  }
}

/** Data publik: aman ditampilkan ke seluruh anggota (tanpa email & nomor WA). */
function km_publicUser_(u) {
  if (!u) return null;
  return {
    userId: String(u.UserID || ''),
    name: String(u.Name || 'Pembaca'),
    username: km_username_(u.Username, u.Name),
    role: String(u.Role || 'Member'),
    joinDate: String(u.JoinDate || ''),
    avatarURL: String(u.AvatarURL || ''),
    bio: String(u.Bio || '')
  };
}

/** Data privat: hanya untuk pemilik akun atau Admin. */
function km_privateUser_(u) {
  var pub = km_publicUser_(u);
  pub.email = String(u.Email || '');
  pub.waSettings = String(u.WaSettings || '');
  pub.alumniJoinDate = String(u.AlumniJoinDate || '');
  return pub;
}

function km_findUserByIdentifier_(identifier) {
  var ident = km_clean_(identifier, 200).toLowerCase();
  if (!ident) return null;
  return km_readTable_('Users').filter(function (u) {
    return km_email_(u.Email) === ident || km_username_(u.Username, u.Name) === ident;
  })[0] || null;
}

/* ==========================================================================
 * SESI & AUTENTIKASI
 * ========================================================================== */

function km_newSession_(user) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var payload = { userId: String(user.UserID), authVersion: String(user.AuthVersion || '1') };
  CacheService.getScriptCache().put('km-sess:' + token, JSON.stringify(payload), KM_CONFIG.SESSION_TTL_SECONDS);
  return { token: token, expiresIn: KM_CONFIG.SESSION_TTL_SECONDS };
}

/** Admin masuk sebagai anggota lain (impersonation). Token baru dikembalikan; token admin tetap berlaku. */
function km_impersonate_(actor, data) {
  km_requireAdmin_(actor);
  var targetId = km_clean_(data.userId, 100);
  if (!targetId) throw km_err_('VALIDATION', 'Pilih anggota yang akan diakses.');
  var target = km_readTable_('Users').filter(function (u) { return String(u.UserID) === targetId; })[0];
  if (!target) throw km_err_('NOT_FOUND', 'Anggota tidak ditemukan.');
  var sess = km_newSession_(target);
  return {
    _message: 'Sekarang Anda masuk sebagai ' + String(target.Name || 'anggota') + '.',
    user: km_privateUser_(target),
    token: sess.token,
    expiresIn: sess.expiresIn,
    impersonatedBy: String(actor.UserID)
  };
}

function km_requireUser_(request) {
  var token = km_clean_(request && request.token, 200);
  if (!token) throw km_err_('UNAUTHENTICATED', 'Sesi berakhir. Silakan masuk kembali.');
  var raw = CacheService.getScriptCache().get('km-sess:' + token);
  if (!raw) throw km_err_('SESSION_EXPIRED', 'Sesi telah berakhir. Silakan masuk kembali.');
  var sess = km_parseJson_(raw, null);
  if (!sess || !sess.userId) throw km_err_('SESSION_INVALID', 'Sesi tidak valid.');
  var user = km_readTable_('Users').filter(function (u) { return String(u.UserID) === String(sess.userId); })[0];
  if (!user || String(user.AuthVersion || '1') !== String(sess.authVersion || '1')) {
    CacheService.getScriptCache().remove('km-sess:' + token);
    throw km_err_('SESSION_EXPIRED', 'Sesi akun telah diperbarui. Silakan masuk kembali.');
  }
  return user;
}

function km_register_(data) {
  var name = km_clean_(data.name, 100);
  var email = km_email_(data.email);
  var password = String(data.password || '');
  var username = km_username_(data.username, name);
  // Username otomatis dari nama yang terlalu pendek diberi angka acak agar tetap valid.
  if (!km_clean_(data.username, 40) && username.length < 3) {
    username = username + Math.floor(1000 + Math.random() * 9000);
  }

  if (name.length < 2) throw km_err_('VALIDATION', 'Nama lengkap minimal 2 karakter.');
  if (!km_validEmail_(email)) throw km_err_('VALIDATION', 'Format email belum valid.');
  if (username.length < 3) throw km_err_('VALIDATION', 'Username minimal 3 karakter (huruf, angka, titik, strip, atau garis bawah).');
  km_validatePassword_(password);

  var rlKey = 'rl:reg:' + email;
  km_rateLimit_(rlKey, KM_CONFIG.RATE_LIMIT.REGISTER_MAX, KM_CONFIG.RATE_LIMIT.REGISTER_WINDOW);

  var users = km_readTable_('Users');
  if (users.some(function (u) { return km_email_(u.Email) === email; })) {
    throw km_err_('EMAIL_TAKEN', 'Email sudah terdaftar. Silakan langsung masuk.');
  }
  if (users.some(function (u) { return km_username_(u.Username, u.Name) === username; })) {
    throw km_err_('USERNAME_TAKEN', 'Username sudah dipakai. Silakan pilih username lain.');
  }

  var isFirstUser = users.length === 0;
  var salt = km_salt_();
  var now = km_now_();
  var record = {
    UserID: km_id_('usr'),
    Name: name,
    Username: username,
    Email: email,
    PasswordHash: km_hash_(password, salt),
    PasswordSalt: salt,
    Role: (isFirstUser || km_adminEmails_().indexOf(email) >= 0) ? 'Admin' : 'Member',
    JoinDate: now,
    AlumniJoinDate: '',
    WaSettings: km_clean_(data.waSettings, 60),
    AvatarURL: km_safeUrl_(data.avatarURL),
    Bio: km_clean_(data.bio || 'Pembaca aktif di Kelas Membaca', 300),
    ResetToken: '',
    AuthVersion: '1',
    UpdatedAt: now
  };
  km_saveRecord_('Users', 'UserID', record);
  km_clearRateLimit_(rlKey);
  var sess = km_newSession_(record);
  return {
    _message: 'Akun berhasil dibuat. Selamat datang di Kelas Membaca!',
    user: km_privateUser_(record),
    token: sess.token,
    expiresIn: sess.expiresIn
  };
}

function km_login_(data) {
  var identifier = km_clean_(data.email || data.identifier || data.username, 200);
  var password = String(data.password || '');
  var user = km_findUserByIdentifier_(identifier);

  var rlKey = 'rl:login:' + (user ? 'uid:' + String(user.UserID) : 'ident:' + identifier.toLowerCase());
  km_rateLimit_(rlKey, KM_CONFIG.RATE_LIMIT.LOGIN_MAX, KM_CONFIG.RATE_LIMIT.LOGIN_WINDOW);

  if (!user || km_hash_(password, String(user.PasswordSalt || '')) !== String(user.PasswordHash || '')) {
    throw km_err_('INVALID_CREDENTIALS', 'Email/username atau kata sandi tidak cocok.');
  }
  if (km_adminEmails_().indexOf(km_email_(user.Email)) >= 0 && !km_isAdmin_(user)) {
    user = km_saveRecord_('Users', 'UserID', Object.assign({}, user, { Role: 'Admin', UpdatedAt: km_now_() }));
  }

  km_clearRateLimit_(rlKey);
  var sess = km_newSession_(user);
  return {
    _message: 'Berhasil masuk.',
    user: km_privateUser_(user),
    token: sess.token,
    expiresIn: sess.expiresIn
  };
}

function km_logout_(request) {
  var token = km_clean_(request && request.token, 200);
  if (token) CacheService.getScriptCache().remove('km-sess:' + token);
  return { loggedOut: true };
}

/**
 * Lupa kata sandi: kode 6 digit dikirim ke email terdaftar (berlaku 15 menit).
 * Respons selalu generik agar tidak membocorkan keberadaan akun.
 */
function km_requestPasswordReset_(data) {
  var ident = km_clean_(data.identifier || data.email || data.username, 200).toLowerCase();
  if (!ident) throw km_err_('VALIDATION', 'Masukkan email atau username terlebih dahulu.');
  km_rateLimit_('rl:pr:' + ident, KM_CONFIG.RATE_LIMIT.RESET_MAX, KM_CONFIG.RATE_LIMIT.RESET_WINDOW);

  var generic = 'Jika akun ditemukan, kode reset telah dikirim ke email yang terdaftar. Periksa kotak masuk atau folder spam.';
  var user = km_findUserByIdentifier_(ident);
  if (!user || !user.Email) return { _message: generic, sent: true };

  var code = String(Math.floor(100000 + Math.random() * 900000));
  var salt = km_salt_();
  CacheService.getScriptCache().put('km-reset:' + user.UserID, JSON.stringify({
    hash: km_hash_(code, salt), salt: salt, attempts: 0
  }), KM_CONFIG.RESET_CODE_TTL);

  var body = 'Halo ' + (user.Name || '') + ',\n\n' +
    'Kode reset kata sandi Kelas Membaca Anda: ' + code + '\n\n' +
    'Kode berlaku 15 menit. Jika Anda tidak meminta reset, abaikan email ini.\n\n' +
    'Salam literasi,\nTim Kelas Membaca';
  try {
    var props = PropertiesService.getScriptProperties();
    MailApp.sendEmail({
      to: user.Email,
      subject: '[Kelas Membaca] Kode reset kata sandi',
      body: body,
      name: props.getProperty('MAIL_NAME') || KM_CONFIG.APP_NAME
    });
  } catch (error) {
    console.error('[KM-MAIL] ' + error);
    throw km_err_('MAIL_FAILED', 'Email reset tidak dapat dikirim saat ini. Coba lagi nanti atau hubungi mentor.');
  }
  return { _message: generic, sent: true };
}

function km_confirmPasswordReset_(data) {
  var ident = km_clean_(data.identifier || data.email || data.username, 200).toLowerCase();
  var code = km_clean_(data.code, 12);
  var newPassword = String(data.newPassword || '');
  if (!ident || !code) throw km_err_('VALIDATION', 'Email/username dan kode reset wajib diisi.');
  km_validatePassword_(newPassword);

  var user = km_findUserByIdentifier_(ident);
  if (!user) throw km_err_('INVALID_CODE', 'Kode reset tidak valid atau sudah kedaluwarsa.');

  var cache = CacheService.getScriptCache();
  var state = km_parseJson_(cache.get('km-reset:' + user.UserID), null);
  if (!state) throw km_err_('INVALID_CODE', 'Kode reset tidak valid atau sudah kedaluwarsa. Minta kode baru.');
  state.attempts = (state.attempts || 0) + 1;
  if (state.attempts > KM_CONFIG.RESET_MAX_ATTEMPTS) {
    cache.remove('km-reset:' + user.UserID);
    throw km_err_('INVALID_CODE', 'Terlalu banyak percobaan salah. Minta kode reset baru.');
  }
  if (km_hash_(code, state.salt) !== state.hash) {
    cache.put('km-reset:' + user.UserID, JSON.stringify(state), KM_CONFIG.RESET_CODE_TTL);
    throw km_err_('INVALID_CODE', 'Kode reset tidak sesuai.');
  }

  var salt = km_salt_();
  km_saveRecord_('Users', 'UserID', Object.assign({}, user, {
    PasswordSalt: salt,
    PasswordHash: km_hash_(newPassword, salt),
    AuthVersion: String(Number(user.AuthVersion || 1) + 1),
    UpdatedAt: km_now_()
  }));
  cache.remove('km-reset:' + user.UserID);
  return { _message: 'Kata sandi berhasil diperbarui. Silakan masuk dengan kata sandi baru.' };
}

function km_changePassword_(user, data) {
  var currentPassword = String(data.currentPassword || '');
  var newPassword = String(data.newPassword || '');
  if (km_hash_(currentPassword, String(user.PasswordSalt || '')) !== String(user.PasswordHash || '')) {
    throw km_err_('INVALID_CREDENTIALS', 'Kata sandi saat ini tidak cocok.');
  }
  km_validatePassword_(newPassword);
  var salt = km_salt_();
  var saved = km_saveRecord_('Users', 'UserID', Object.assign({}, user, {
    PasswordSalt: salt,
    PasswordHash: km_hash_(newPassword, salt),
    AuthVersion: String(Number(user.AuthVersion || 1) + 1),
    UpdatedAt: km_now_()
  }));
  var sess = km_newSession_(saved);
  return {
    _message: 'Kata sandi berhasil diperbarui.',
    user: km_privateUser_(saved),
    token: sess.token,
    expiresIn: sess.expiresIn
  };
}

function km_updateProfile_(user, data) {
  var name = km_clean_(data.name, 100);
  if (name.length < 2) throw km_err_('VALIDATION', 'Nama minimal 2 karakter.');
  var username = km_username_(data.username, name);
  if (username.length < 3) throw km_err_('VALIDATION', 'Username minimal 3 karakter.');
  if (username !== km_username_(user.Username, user.Name)) {
    var clash = km_readTable_('Users').some(function (u) {
      return String(u.UserID) !== String(user.UserID) && km_username_(u.Username, u.Name) === username;
    });
    if (clash) throw km_err_('USERNAME_TAKEN', 'Username "' + username + '" sudah dipakai. Pilih yang lain.');
  }
  var record = Object.assign({}, user, {
    Name: name,
    Username: username,
    WaSettings: km_clean_(data.waSettings, 60),
    Bio: km_clean_(data.bio, 300),
    AvatarURL: data.avatarURL !== undefined ? km_safeUrl_(data.avatarURL) : String(user.AvatarURL || ''),
    UpdatedAt: km_now_()
  });
  var saved = km_saveRecord_('Users', 'UserID', record);
  return { _message: 'Profil berhasil diperbarui.', user: km_privateUser_(saved) };
}

/* ==========================================================================
 * GOOGLE DRIVE — PENYIMPANAN SAMPUL BUKU
 * ========================================================================== */

function km_coverFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('COVER_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* folder hilang, buat ulang */ }
  }
  var folder = DriveApp.createFolder(KM_CONFIG.COVER_FOLDER_NAME);
  props.setProperty('COVER_FOLDER_ID', folder.getId());
  return folder;
}

/** Mengunggah gambar sampul (base64) ke Drive dan mengembalikan URL publik. */
function km_uploadCoverFile_(base64Raw, mimeRaw, fileNameRaw) {
  var mimeType = km_clean_(mimeRaw, 40).toLowerCase();
  var extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  if (!extMap[mimeType]) {
    throw km_err_('VALIDATION', 'Format sampul harus JPG, PNG, atau WEBP.');
  }
  var base64 = String(base64Raw || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!base64) throw km_err_('VALIDATION', 'Berkas sampul kosong.');
  if (base64.length * 0.75 > KM_CONFIG.MAX_COVER_BYTES) {
    throw km_err_('VALIDATION', 'Ukuran sampul maksimal 3 MB.');
  }
  var bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (e) {
    throw km_err_('VALIDATION', 'Data gambar tidak valid.');
  }
  var baseName = km_clean_(fileNameRaw, 60).replace(/[^\w.-]+/g, '_') || 'sampul';
  var fileName = baseName + '.' + extMap[mimeType];
  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var file = km_coverFolder_().createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    try { file.setTrashed(true); } catch (e2) { /* noop */ }
    throw km_err_('DRIVE_SHARING', 'Kebijakan Drive melarang berbagi publik. Izinkan "Anyone with the link" untuk folder sampul.');
  }
  return {
    fileId: file.getId(),
    url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800'
  };
}

function km_trashCoverFile_(fileId) {
  if (!fileId) return;
  try {
    DriveApp.getFileById(String(fileId)).setTrashed(true);
  } catch (e) {
    console.warn('[KM-DRIVE] Gagal menghapus sampul ' + fileId + ': ' + e);
  }
}

function km_canEditBook_(user, book) {
  return String(book.UserID) === String(user.UserID) || km_isAdmin_(user);
}

function km_uploadBookCover_(user, data) {
  var bookId = km_clean_(data.bookId, 100);
  var book = km_readTable_('ReadingBooks').filter(function (b) { return String(b.BookID) === bookId; })[0];
  if (!book) throw km_err_('NOT_FOUND', 'Simpan buku terlebih dahulu sebelum mengunggah sampul.');
  if (!km_canEditBook_(user, book)) throw km_err_('FORBIDDEN', 'Anda tidak dapat mengubah sampul buku ini.');

  var up = km_uploadCoverFile_(data.base64, data.mimeType, data.fileName);
  var oldFileId = book.CoverFileID;
  var saved = km_saveRecord_('ReadingBooks', 'BookID', Object.assign({}, book, {
    CoverURL: up.url,
    CoverFileID: up.fileId,
    UpdatedAt: km_now_()
  }));
  if (oldFileId && oldFileId !== up.fileId) km_trashCoverFile_(oldFileId);
  var owner = km_readTable_('Users').filter(function (u) { return String(u.UserID) === String(saved.UserID); })[0];
  return {
    _message: 'Sampul buku berhasil diunggah ke Google Drive.',
    book: km_normalizeBook_(saved, owner ? { [String(owner.UserID)]: km_publicUser_(owner) } : {}),
    coverURL: up.url,
    coverFileId: up.fileId
  };
}

function km_deleteBookCover_(user, data) {
  var bookId = km_clean_(data.bookId, 100);
  var book = km_readTable_('ReadingBooks').filter(function (b) { return String(b.BookID) === bookId; })[0];
  if (!book) throw km_err_('NOT_FOUND', 'Buku bacaan tidak ditemukan.');
  if (!km_canEditBook_(user, book)) throw km_err_('FORBIDDEN', 'Anda tidak dapat menghapus sampul buku ini.');
  km_trashCoverFile_(book.CoverFileID);
  var saved = km_saveRecord_('ReadingBooks', 'BookID', Object.assign({}, book, {
    CoverURL: '', CoverFileID: '', UpdatedAt: km_now_()
  }));
  return { _message: 'Sampul buku dihapus. Tampilan kembali memakai sampul otomatis.', book: km_normalizeBook_(saved, {}) };
}

/* ==========================================================================
 * NORMALISASI DATA UNTUK KLIEN
 * ========================================================================== */

function km_normalizeBook_(book, usersById) {
  var owner = usersById && usersById[String(book.UserID)]
    ? usersById[String(book.UserID)]
    : { userId: String(book.UserID || ''), name: 'Pembaca', username: 'pembaca' };
  var totalPages = Math.max(1, Number(book.TotalPages || 100));
  var currentPage = Math.min(totalPages, Math.max(0, Number(book.CurrentPage || 0)));
  var pct = Math.min(100, Number(((currentPage / totalPages) * 100).toFixed(1)));
  return {
    bookId: String(book.BookID || ''),
    userId: String(book.UserID || ''),
    readerName: owner.name,
    readerHandle: owner.username,
    title: String(book.Title || ''),
    author: String(book.Author || 'Penulis'),
    totalPages: totalPages,
    currentPage: currentPage,
    progressPct: pct,
    coverURL: String(book.CoverURL || ''),
    coverFileId: String(book.CoverFileID || ''),
    topic: String(book.Topic || 'umum'),
    status: currentPage >= totalPages ? 'Finished' : (String(book.Status || 'Reading') === 'Finished' ? 'Reading' : String(book.Status || 'Reading')),
    lastReadAt: String(book.LastReadAt || ''),
    createdAt: String(book.CreatedAt || ''),
    updatedAt: String(book.UpdatedAt || '')
  };
}

function km_normalizeLog_(log, usersById, commentsByLog, coverByBook) {
  var owner = usersById && usersById[String(log.UserID)]
    ? usersById[String(log.UserID)]
    : { userId: String(log.UserID || ''), name: 'Pembaca', username: 'pembaca', avatarURL: '' };
  var totalBookPages = Math.max(1, Number(log.TotalBookPages || log.EndPage || 100));
  var endPage = Math.max(0, Number(log.EndPage || log.PagesRead || 0));
  var pagesRead = Math.max(1, Number(log.PagesRead || 1));
  var startPage = Math.max(0, Number(log.StartPage || Math.max(1, endPage - pagesRead + 1)));
  var bookId = String(log.BookID || '');
  var comments = (commentsByLog && commentsByLog[String(log.LogID)]) || [];
  return {
    logId: String(log.LogID || ''),
    userId: String(log.UserID || ''),
    userName: owner.name,
    userHandle: owner.username,
    userAvatar: owner.avatarURL || '',
    bookId: bookId,
    date: km_dateOnly_(log.Date),
    startTime: String(log.StartTime || ''),
    endTime: String(log.EndTime || ''),
    bookTitle: String(log.BookTitle || 'Buku Bacaan'),
    author: String(log.Author || 'Penulis'),
    totalBookPages: totalBookPages,
    coverURL: (coverByBook && coverByBook[bookId]) || String(log.CoverURL || ''),
    startPage: startPage,
    endPage: endPage,
    pagesRead: pagesRead,
    progressPct: Math.min(100, Number(((endPage / totalBookPages) * 100).toFixed(1))),
    totalMinutes: Number(log.TotalMinutes || 0),
    effectiveMinutes: Number(log.EffectiveMinutes || 0),
    insight: String(log.Insight || ''),
    topic: String(log.Topic || 'umum'),
    isPublic: km_isPublic_(log),
    commentsCount: comments.length,
    comments: comments,
    createdAt: String(log.CreatedAt || ''),
    updatedAt: String(log.UpdatedAt || '')
  };
}

function km_normalizeClass_(cls, membersCount, joined) {
  return {
    classId: String(cls.ClassID || ''),
    className: String(cls.ClassName || ''),
    batchNumber: Number(cls.BatchNumber || 0),
    classType: String(cls.ClassType || 'Batch') === 'Alumni' ? 'Alumni' : 'Batch',
    description: String(cls.Description || ''),
    mentorName: String(cls.MentorName || 'Mentor'),
    startDate: km_dateOnly_(cls.StartDate),
    endDate: km_dateOnly_(cls.EndDate),
    closeDate: km_dateOnly_(cls.CloseDate),
    targetPagesPerDay: Number(cls.TargetPagesPerDay || KM_CONFIG.DAILY_TARGET_PAGES),
    minGradTasks: Number(cls.MinGradTasks === '' || cls.MinGradTasks === undefined ? 6 : cls.MinGradTasks),
    minGradPages: Number(cls.MinGradPages === '' || cls.MinGradPages === undefined ? 1000 : cls.MinGradPages),
    status: String(cls.Status || 'Active') === 'Closed' ? 'Closed' : 'Active',
    membersCount: membersCount || 0,
    joined: Boolean(joined),
    createdAt: String(cls.CreatedAt || ''),
    updatedAt: String(cls.UpdatedAt || '')
  };
}

function km_taskForClient_(task, submission, cls, allUserTasks) {
  var tid = String(task.TaskID || '');
  var activeDate = km_dateOnly_(task.ActiveDate || task.Deadline);
  var subCount = allUserTasks ? allUserTasks.filter(function (s) { return String(s.TaskID) === tid; }).length : 0;
  return {
    taskId: tid,
    classId: String(task.ClassID || ''),
    className: cls ? String(cls.className || cls.ClassName || '') : 'Kelas Membaca',
    taskNumber: Number(task.TaskNumber || 0),
    title: String(task.Title || ''),
    description: String(task.Description || ''),
    activeDate: activeDate,
    deadline: activeDate,
    form: km_parseJson_(task.FormJSON, []),
    validationRule: km_parseJson_(task.ValidationRuleJSON, {}),
    status: String(task.Status || 'Published'),
    submissionCount: subCount,
    submission: submission ? {
      userTaskId: String(submission.UserTaskID || ''),
      status: String(submission.Status || ''),
      answers: km_parseJson_(submission.AnswersJSON, {}),
      feedback: String(submission.Feedback || ''),
      score: (submission.Score === '' || submission.Score === null || submission.Score === undefined) ? null : Number(submission.Score),
      submittedAt: String(submission.SubmittedAt || ''),
      reviewedAt: String(submission.ReviewedAt || '')
    } : null
  };
}

/* ==========================================================================
 * RAK BUKU (BOOKS) — CRUD
 * ========================================================================== */

function km_saveReadingBook_(user, data) {
  var bookId = km_clean_(data.bookId, 100) || km_id_('bk');
  var books = km_readTable_('ReadingBooks');
  var existing = books.filter(function (b) { return String(b.BookID) === bookId; })[0] || null;
  if (existing && !km_canEditBook_(user, existing)) {
    throw km_err_('FORBIDDEN', 'Anda tidak dapat mengubah buku milik pengguna lain.');
  }

  var title = km_clean_(data.title, 180);
  var author = km_clean_(data.author, 140);
  if (title.length < 2) throw km_err_('VALIDATION', 'Judul buku minimal 2 karakter.');
  if (author.length < 2) throw km_err_('VALIDATION', 'Nama penulis buku wajib diisi.');

  var totalPages = Math.round(km_num_(data.totalPages, 1, 50000, existing ? Number(existing.TotalPages || 200) : 200));
  var currentPage = Math.round(km_num_(data.currentPage, 0, totalPages, existing ? Number(existing.CurrentPage || 0) : 0));
  var now = km_now_();

  var coverURL = existing ? km_safeUrl_(existing.CoverURL) : '';
  var coverFileId = existing ? String(existing.CoverFileID || '') : '';
  var incomingUrl = km_clean_(data.coverURL, 2000);
  if (incomingUrl && incomingUrl !== coverURL) {
    if (!km_safeUrl_(incomingUrl)) throw km_err_('VALIDATION', 'Tautan sampul harus diawali https://');
    // Tautan eksternal menggantikan sampul lama; berkas Drive lama dihapus.
    km_trashCoverFile_(coverFileId);
    coverURL = km_safeUrl_(incomingUrl);
    coverFileId = '';
  }
  if (data.removeCover === true) {
    km_trashCoverFile_(coverFileId);
    coverURL = '';
    coverFileId = '';
  }

  var record = {
    BookID: bookId,
    UserID: existing ? String(existing.UserID) : String(user.UserID),
    Title: title,
    Author: author,
    TotalPages: totalPages,
    CurrentPage: currentPage,
    CoverURL: coverURL,
    CoverFileID: coverFileId,
    Topic: km_clean_(data.topic || (existing ? existing.Topic : '') || 'literasi', 120),
    Status: currentPage >= totalPages ? 'Finished' : 'Reading',
    LastReadAt: existing ? String(existing.LastReadAt || '') : '',
    CreatedAt: existing ? String(existing.CreatedAt || now) : now,
    UpdatedAt: now
  };
  var saved = km_saveRecord_('ReadingBooks', 'BookID', record);
  var owner = km_readTable_('Users').filter(function (u) { return String(u.UserID) === String(saved.UserID); })[0];
  return {
    _message: 'Buku bacaan berhasil disimpan.',
    book: km_normalizeBook_(saved, owner ? { [String(owner.UserID)]: km_publicUser_(owner) } : {})
  };
}

function km_deleteReadingBook_(user, data) {
  var bookId = km_clean_(data.bookId, 100);
  var book = km_readTable_('ReadingBooks').filter(function (b) { return String(b.BookID) === bookId; })[0];
  if (!book) throw km_err_('NOT_FOUND', 'Buku bacaan tidak ditemukan.');
  if (!km_canEditBook_(user, book)) throw km_err_('FORBIDDEN', 'Anda tidak memiliki izin menghapus buku ini.');

  var logIds = km_readTable_('ReadingLogs').filter(function (l) {
    return String(l.BookID) === bookId;
  }).map(function (l) { return String(l.LogID); });

  if (logIds.length) {
    km_deleteWhere_('Comments', function (c) { return logIds.indexOf(String(c.LogID)) >= 0; });
    km_deleteWhere_('ReadingLogs', function (l) { return logIds.indexOf(String(l.LogID)) >= 0; });
  }
  km_trashCoverFile_(book.CoverFileID);
  km_deleteWhere_('ReadingBooks', function (b) { return String(b.BookID) === bookId; });

  return {
    _message: 'Buku beserta ' + logIds.length + ' catatan terkait berhasil dihapus.',
    deleted: true,
    removedLogs: logIds.length
  };
}

/** Menghitung ulang progres halaman buku dari seluruh log milik pemilik buku. */
function km_recalcBook_(bookId, ownerId) {
  var book = km_readTable_('ReadingBooks').filter(function (b) { return String(b.BookID) === String(bookId); })[0];
  if (!book) return null;
  var maxPage = km_readTable_('ReadingLogs').filter(function (l) {
    return String(l.BookID) === String(bookId) && (!ownerId || String(l.UserID) === String(ownerId));
  }).reduce(function (mx, l) { return Math.max(mx, Number(l.EndPage || 0)); }, 0);
  var total = Math.max(1, Number(book.TotalPages || 1));
  var current = Math.min(total, maxPage);
  return km_saveRecord_('ReadingBooks', 'BookID', Object.assign({}, book, {
    CurrentPage: current,
    Status: current >= total ? 'Finished' : 'Reading',
    UpdatedAt: km_now_()
  }));
}

/* ==========================================================================
 * CATATAN MEMBACA (LOGS), TIMELINE & KOMENTAR
 * ========================================================================== */

function km_saveLog_(user, data) {
  var logId = km_clean_(data.logId, 100) || km_id_('log');
  var existing = km_readTable_('ReadingLogs').filter(function (l) { return String(l.LogID) === logId; })[0] || null;
  if (existing && !km_canEditBook_(user, existing)) {
    throw km_err_('FORBIDDEN', 'Anda tidak dapat mengubah catatan baca milik pengguna lain.');
  }
  var ownerId = existing ? String(existing.UserID) : String(user.UserID);

  var bookTitle = km_clean_(data.bookTitle, 180);
  var author = km_clean_(data.author, 140);

  var startPage = Math.round(km_num_(data.startPage, 1, 50000, 1));
  var endPage = Math.round(km_num_(data.endPage, startPage, 50000, startPage));
  var pagesRead = Math.max(1, endPage - startPage + 1);
  var books = km_readTable_('ReadingBooks');
  var bookId = km_clean_(data.bookId, 100);
  var matched = null;
  if (bookId) {
    matched = books.filter(function (b) { return String(b.BookID) === bookId && String(b.UserID) === ownerId; })[0] || null;
    if (!matched && books.some(function (b) { return String(b.BookID) === bookId; })) {
      throw km_err_('FORBIDDEN', 'Buku yang dipilih bukan milik pembaca ini.');
    }
  }
  if (!matched) {
    matched = books.filter(function (b) {
      return String(b.UserID) === ownerId && String(b.Title || '').toLowerCase() === bookTitle.toLowerCase();
    })[0] || null;
  }

  if (matched) {
    if (!bookTitle) bookTitle = km_clean_(matched.Title, 180);
    if (!author) author = km_clean_(matched.Author, 140);
  }
  if (bookTitle.length < 2) throw km_err_('VALIDATION', 'Judul buku wajib diisi.');
  if (author.length < 2) throw km_err_('VALIDATION', 'Nama penulis buku wajib diisi.');

  var totalBookPages = Math.round(km_num_(data.totalBookPages, endPage, 50000, Math.max(endPage, 200)));
  var finalTotal = matched ? Math.max(Number(matched.TotalPages || 0), totalBookPages, endPage) : totalBookPages;
  var totalMinutes = Math.round(km_num_(data.totalMinutes, 1, 1440, 1));
  var effectiveMinutes = Math.round(km_num_(data.effectiveMinutes, 0, totalMinutes, totalMinutes));

  var insight = km_clean_(data.insight, 3000);
  if (insight.length < 3) throw km_err_('VALIDATION', 'Kesimpulan / insight bacaan wajib diisi (minimal 3 karakter).');

  var topic = km_clean_(data.topic || 'literasi', 120);
  var now = km_now_();
  var finalBookId = matched ? String(matched.BookID) : (bookId || km_id_('bk'));

  // Pastikan buku ada (dibuat otomatis bila belum ada di rak).
  var bookRecord = Object.assign({
    BookID: finalBookId,
    UserID: ownerId,
    CurrentPage: 0,
    CoverURL: '',
    CoverFileID: '',
    Status: 'Reading',
    LastReadAt: '',
    CreatedAt: now
  }, matched || {}, {
    BookID: finalBookId,
    UserID: ownerId,
    Title: matched ? matched.Title : bookTitle,
    Author: matched ? matched.Author : author,
    TotalPages: finalTotal,
    Topic: matched ? (matched.Topic || topic) : topic,
    LastReadAt: now,
    UpdatedAt: now
  });
  km_saveRecord_('ReadingBooks', 'BookID', bookRecord);

  var logRecord = {
    LogID: logId,
    UserID: ownerId,
    BookID: finalBookId,
    ClassID: km_clean_(data.classId, 100),
    Date: km_safeDate_(data.date),
    StartTime: km_clean_(data.startTime, 40),
    EndTime: km_clean_(data.endTime, 40),
    BookTitle: bookRecord.Title,
    Author: bookRecord.Author,
    TotalBookPages: finalTotal,
    CoverURL: bookRecord.CoverURL || '',
    StartPage: startPage,
    EndPage: endPage,
    PagesRead: pagesRead,
    TotalMinutes: totalMinutes,
    EffectiveMinutes: effectiveMinutes,
    Insight: insight,
    Topic: topic,
    IsPublic: data.isPublic === undefined ? true : km_isTrue_(data.isPublic),
    CreatedAt: existing ? String(existing.CreatedAt || now) : now,
    UpdatedAt: now
  };
  var savedLog = km_saveRecord_('ReadingLogs', 'LogID', logRecord);

  // Jika log pindah buku, hitung ulang buku lama.
  if (existing && String(existing.BookID) !== finalBookId) km_recalcBook_(existing.BookID, ownerId);
  var savedBook = km_recalcBook_(finalBookId, ownerId);

  var owner = km_readTable_('Users').filter(function (u) { return String(u.UserID) === ownerId; })[0];
  var usersById = owner ? { [ownerId]: km_publicUser_(owner) } : {};
  var coverMap = {};
  if (savedBook && savedBook.CoverURL) coverMap[finalBookId] = savedBook.CoverURL;
  return {
    _message: 'Catatan membaca dan kesimpulan berhasil disimpan!',
    log: km_normalizeLog_(savedLog, usersById, {}, coverMap),
    book: km_normalizeBook_(savedBook || bookRecord, usersById)
  };
}

function km_deleteLog_(user, data) {
  var logId = km_clean_(data.logId, 100);
  var target = km_readTable_('ReadingLogs').filter(function (l) { return String(l.LogID) === logId; })[0];
  if (!target) throw km_err_('NOT_FOUND', 'Catatan baca tidak ditemukan.');
  if (!km_canEditBook_(user, target)) throw km_err_('FORBIDDEN', 'Anda tidak memiliki akses menghapus catatan ini.');

  km_deleteWhere_('Comments', function (c) { return String(c.LogID) === logId; });
  km_deleteWhere_('ReadingLogs', function (l) { return String(l.LogID) === logId; });
  km_recalcBook_(target.BookID, target.UserID);
  return { _message: 'Catatan membaca dihapus.', deleted: true };
}

function km_commentsByLog_(tables, usersById) {
  var map = {};
  tables.Comments.forEach(function (c) {
    var lid = String(c.LogID || '');
    if (!map[lid]) map[lid] = [];
    var author = usersById[String(c.UserID)] || { name: 'Pembaca', username: 'pembaca', avatarURL: '' };
    map[lid].push({
      commentId: String(c.CommentID || ''),
      logId: lid,
      userId: String(c.UserID || ''),
      userName: author.name,
      userHandle: author.username,
      userAvatar: author.avatarURL || '',
      commentText: String(c.CommentText || ''),
      createdAt: String(c.CreatedAt || '')
    });
  });
  Object.keys(map).forEach(function (k) {
    map[k].sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
  });
  return map;
}

function km_bookTimeline_(user, data) {
  var tables = km_readTables_(['Users', 'ReadingBooks', 'ReadingLogs', 'Comments']);
  var usersById = {};
  tables.Users.forEach(function (u) { usersById[String(u.UserID)] = km_publicUser_(u); });
  var commentsByLog = km_commentsByLog_(tables, usersById);
  var coverMap = {};
  tables.ReadingBooks.forEach(function (b) { if (b.CoverURL) coverMap[String(b.BookID)] = String(b.CoverURL); });

  var isAdmin = km_isAdmin_(user);
  var visible = tables.ReadingLogs.filter(function (l) {
    return km_isPublic_(l) || String(l.UserID) === String(user.UserID) || isAdmin;
  });
  var bookId = km_clean_(data.bookId, 100);
  var logId = km_clean_(data.logId, 100);
  var all = visible.map(function (l) { return km_normalizeLog_(l, usersById, commentsByLog, coverMap); });
  var primary = logId ? all.filter(function (l) { return l.logId === logId; })[0] : null;
  var targetBookId = bookId || (primary ? primary.bookId : '');

  var bookRow = tables.ReadingBooks.filter(function (b) { return String(b.BookID) === targetBookId; })[0] || null;
  var timeline = all.filter(function (l) {
    return targetBookId && l.bookId === targetBookId;
  }).sort(function (a, b) {
    return (b.date + b.createdAt).localeCompare(a.date + a.createdAt);
  });
  return {
    book: bookRow ? km_normalizeBook_(bookRow, usersById) : null,
    latestLog: primary || timeline[0] || null,
    timeline: timeline
  };
}

function km_addComment_(user, data) {
  var logId = km_clean_(data.logId, 100);
  var text = km_clean_(data.commentText, 1200);
  if (!logId) throw km_err_('VALIDATION', 'ID catatan baca tidak ditemukan.');
  if (text.length < 2) throw km_err_('VALIDATION', 'Tulis komentar minimal 2 karakter.');

  var log = km_readTable_('ReadingLogs').filter(function (l) { return String(l.LogID) === logId; })[0];
  if (!log) throw km_err_('NOT_FOUND', 'Catatan baca yang dikomentari tidak ditemukan.');
  var isOwner = String(log.UserID) === String(user.UserID);
  if (!km_isPublic_(log) && !isOwner && !km_isAdmin_(user)) {
    throw km_err_('FORBIDDEN', 'Catatan baca ini bersifat privat dan tidak dapat dikomentari.');
  }
  var record = {
    CommentID: km_id_('cmt'),
    LogID: logId,
    UserID: String(user.UserID),
    CommentText: text,
    CreatedAt: km_now_()
  };
  km_saveRecord_('Comments', 'CommentID', record);
  var pub = km_publicUser_(user);
  return {
    _message: 'Komentar berhasil dikirim.',
    comment: {
      commentId: record.CommentID, logId: logId, userId: pub.userId,
      userName: pub.name, userHandle: pub.username, userAvatar: pub.avatarURL,
      commentText: text, createdAt: record.CreatedAt
    }
  };
}

function km_deleteComment_(user, data) {
  var commentId = km_clean_(data.commentId, 100);
  var target = km_readTable_('Comments').filter(function (c) { return String(c.CommentID) === commentId; })[0];
  if (!target) throw km_err_('NOT_FOUND', 'Komentar tidak ditemukan.');
  if (String(target.UserID) !== String(user.UserID) && !km_isAdmin_(user)) {
    throw km_err_('FORBIDDEN', 'Anda tidak dapat menghapus komentar pengguna lain.');
  }
  km_deleteWhere_('Comments', function (c) { return String(c.CommentID) === commentId; });
  return { _message: 'Komentar dihapus.', deleted: true };
}

function km_toggleFriend_(user, data) {
  var friendUserId = km_clean_(data.friendUserId, 100);
  if (!friendUserId || friendUserId === String(user.UserID)) {
    throw km_err_('VALIDATION', 'Pilih pengguna lain untuk dijadikan teman membaca.');
  }
  if (!km_readTable_('Users').some(function (u) { return String(u.UserID) === friendUserId; })) {
    throw km_err_('NOT_FOUND', 'Pengguna yang ingin dijadikan teman tidak ditemukan.');
  }
  var me = String(user.UserID);
  var match = function (f) {
    return (String(f.UserID) === me && String(f.FriendUserID) === friendUserId) ||
           (String(f.UserID) === friendUserId && String(f.FriendUserID) === me);
  };
  if (km_readTable_('Friends').some(match)) {
    km_deleteWhere_('Friends', match);
    return { _message: 'Pertemanan dilepaskan.', isFriend: false, friendUserId: friendUserId };
  }
  km_saveRecord_('Friends', 'FriendID', {
    FriendID: km_id_('frd'), UserID: me, FriendUserID: friendUserId, Status: 'Accepted', CreatedAt: km_now_()
  });
  return { _message: 'Berhasil berteman! Aktivitas membacanya kini tampil di feed Anda.', isFriend: true, friendUserId: friendUserId };
}

function km_userBookshelf_(user, data) {
  var targetId = km_clean_(data.userId, 100);
  if (!targetId) throw km_err_('VALIDATION', 'Pilih anggota yang ingin dilihat rak bukunya.');
  var tables = km_readTables_(['Users', 'ReadingBooks']);
  var target = tables.Users.filter(function (u) { return String(u.UserID) === targetId; })[0];
  if (!target) throw km_err_('NOT_FOUND', 'Anggota tidak ditemukan.');
  var usersById = {};
  usersById[targetId] = km_publicUser_(target);
  var all = tables.ReadingBooks.filter(function (b) { return String(b.UserID) === targetId; })
    .map(function (b) { return km_normalizeBook_(b, usersById); })
    .sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
  return {
    user: km_publicUser_(target),
    readingBooks: all.filter(function (b) { return b.status !== 'Finished'; }),
    finishedBooks: all.filter(function (b) { return b.status === 'Finished'; }),
    totalBooks: all.length
  };
}

/* ==========================================================================
 * DASHBOARD (SATU REQUEST UNTUK SELURUH BERANDA)
 * ========================================================================== */

function km_dashboard_(user) {
  var tables = km_readTables_([
    'Users', 'Friends', 'ReadingBooks', 'ReadingLogs', 'Comments',
    'Classes', 'ClassMembers', 'Tasks', 'UserTasks'
  ]);
  var isAdmin = km_isAdmin_(user);
  var me = String(user.UserID);

  var usersById = {};
  tables.Users.forEach(function (u) { usersById[String(u.UserID)] = km_publicUser_(u); });
  var commentsByLog = km_commentsByLog_(tables, usersById);
  var coverMap = {};
  tables.ReadingBooks.forEach(function (b) { if (b.CoverURL) coverMap[String(b.BookID)] = String(b.CoverURL); });

  var allLogs = tables.ReadingLogs.map(function (l) {
    return km_normalizeLog_(l, usersById, commentsByLog, coverMap);
  }).sort(function (a, b) {
    return (b.date + b.createdAt).localeCompare(a.date + a.createdAt);
  });
  var myLogs = allLogs.filter(function (l) { return l.userId === me; });
  var communityLogs = allLogs.filter(function (l) {
    return l.isPublic || l.userId === me || isAdmin;
  }).slice(0, 200);

  var allBooks = tables.ReadingBooks.map(function (b) {
    return km_normalizeBook_(b, usersById);
  }).sort(function (a, b) {
    return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
  });
  var myBooks = allBooks.filter(function (b) { return b.userId === me; });

  var friendIds = {};
  tables.Friends.forEach(function (f) {
    if (String(f.UserID) === me) friendIds[String(f.FriendUserID)] = true;
    else if (String(f.FriendUserID) === me) friendIds[String(f.UserID)] = true;
  });

  var directory = tables.Users.map(function (u) {
    var pub = km_publicUser_(u);
    var uid = pub.userId;
    var uLogs = allLogs.filter(function (l) { return l.userId === uid && (l.isPublic || uid === me || isAdmin); });
    return {
      userId: uid,
      name: pub.name,
      username: pub.username,
      role: pub.role,
      avatarURL: pub.avatarURL,
      bio: pub.bio,
      isFriend: Boolean(friendIds[uid]),
      isMe: uid === me,
      booksCount: allBooks.filter(function (b) { return b.userId === uid; }).length,
      logsCount: uLogs.length,
      pagesRead: uLogs.reduce(function (s, l) { return s + Number(l.pagesRead || 0); }, 0)
    };
  });

  var myClassIds = tables.ClassMembers
    .filter(function (cm) { return String(cm.UserID) === me; })
    .map(function (cm) { return String(cm.ClassID); });

  var classes = tables.Classes.map(function (cls) {
    var cid = String(cls.ClassID || '');
    return km_normalizeClass_(cls,
      tables.ClassMembers.filter(function (m) { return String(m.ClassID) === cid; }).length,
      myClassIds.indexOf(cid) >= 0);
  });

  var myUserTasks = tables.UserTasks.filter(function (ut) { return String(ut.UserID) === me; });
  var tasks = tables.Tasks.filter(function (t) {
    return isAdmin || (myClassIds.indexOf(String(t.ClassID)) >= 0 && String(t.Status) !== 'Draft');
  }).map(function (t) {
    var cls = classes.filter(function (c) { return c.classId === String(t.ClassID); })[0];
    var sub = myUserTasks.filter(function (ut) { return String(ut.TaskID) === String(t.TaskID); })[0] || null;
    return km_taskForClient_(t, sub, cls, tables.UserTasks);
  });

  return {
    serverDate: km_todayWIB_(),
    user: km_privateUser_(user),
    myBooks: myBooks,
    communityBooks: allBooks.slice(0, 120),
    myLogs: myLogs,
    communityLogs: communityLogs,
    people: directory,
    classes: classes,
    tasks: tasks,
    users: isAdmin ? tables.Users.map(km_privateUser_) : [],
    friends: tables.Friends.map(function (f) {
      return { friendId: String(f.FriendID), userId: String(f.UserID), friendUserId: String(f.FriendUserID), status: String(f.Status || 'Accepted') };
    }),
    classMembers: tables.ClassMembers.map(function (m) {
      return { enrollmentId: String(m.EnrollmentID), classId: String(m.ClassID), userId: String(m.UserID), joinDate: String(m.JoinDate || '') };
    }),
    userTasks: myUserTasks.map(function (ut) {
      return {
        userTaskId: String(ut.UserTaskID), userId: String(ut.UserID), taskId: String(ut.TaskID),
        status: String(ut.Status || ''), answers: km_parseJson_(ut.AnswersJSON, {}),
        feedback: String(ut.Feedback || ''),
        score: (ut.Score === '' || ut.Score === null || ut.Score === undefined) ? null : Number(ut.Score),
        submittedAt: String(ut.SubmittedAt || '')
      };
    })
  };
}

/** Katalog publik untuk Landing Page: buku terbaru (progres ≥ 3 halaman) + statistik agregat. */
function km_publicCatalog_() {
  var tables = km_readTables_(['Users', 'ReadingBooks', 'ReadingLogs']);
  var usersById = {};
  tables.Users.forEach(function (u) { usersById[String(u.UserID)] = km_publicUser_(u); });

  var eligible = tables.ReadingBooks.filter(function (b) { return Number(b.CurrentPage || 0) >= 3; })
    .sort(function (a, b) { return String(b.UpdatedAt || '').localeCompare(String(a.UpdatedAt || '')); });
  var books = eligible.slice(0, 8).map(function (b) {
    var owner = usersById[String(b.UserID)] || { name: 'Pembaca', username: 'pembaca' };
    var n = km_normalizeBook_(b, usersById);
    return {
      bookId: n.bookId, title: n.title, author: n.author, totalPages: n.totalPages,
      currentPage: n.currentPage, progressPct: n.progressPct, coverURL: n.coverURL,
      topic: n.topic, readerName: owner.name, readerHandle: owner.username, lastReadAt: n.lastReadAt
    };
  });

  var totalPages = tables.ReadingLogs.reduce(function (s, l) { return s + Number(l.PagesRead || 0); }, 0);
  return {
    books: books,
    stats: {
      members: tables.Users.length,
      books: tables.ReadingBooks.length,
      sessions: tables.ReadingLogs.length,
      pages: totalPages
    }
  };
}

/* ==========================================================================
 * KELAS BATCH, ALUMNI, TUGAS & PAPAN PERINGKAT
 * ========================================================================== */

function km_isAlumniClass_(cls) {
  return String(cls.ClassType || '') === 'Alumni' || /alumni/i.test(String(cls.ClassName || ''));
}

/** Progres anggota di satu kelas (atau komunitas bila cls kosong) dalam rentang tanggal yang sesuai. */
function km_progressFor_(t, uid, cls, days) {
  var today = km_todayWIB_();
  var from = '';
  var to = '9999-12-31';
  if (cls && km_isAlumniClass_(cls)) {
    var u = t.Users.filter(function (x) { return String(x.UserID) === uid; })[0];
    from = km_dateOnly_(u && (u.AlumniJoinDate || u.JoinDate));
  } else if (cls) {
    from = km_dateOnly_(cls.StartDate);
    to = km_dateOnly_(cls.EndDate) || to;
  } else {
    from = km_addDays_(today, -(days || 30));
  }
  var pages = 0, minutes = 0, sessions = 0;
  t.ReadingLogs.forEach(function (l) {
    if (String(l.UserID) !== uid) return;
    var d = km_dateOnly_(l.Date);
    if (from && d < from) return;
    if (d > to) return;
    pages += Number(l.PagesRead || 0);
    minutes += Number(l.EffectiveMinutes || 0);
    sessions++;
  });
  var taskIds = {};
  t.Tasks.forEach(function (task) {
    if (!cls || String(task.ClassID) === String(cls.ClassID)) taskIds[String(task.TaskID)] = true;
  });
  var tasks = t.UserTasks.filter(function (ut) {
    var st = String(ut.Status || '');
    return String(ut.UserID) === uid && taskIds[String(ut.TaskID)] && (st === 'Submitted' || st === 'Reviewed');
  }).length;
  return { pages: pages, minutes: minutes, sessions: sessions, tasks: tasks };
}

function km_listClasses_(user) {
  var tables = km_readTables_(['Classes', 'ClassMembers']);
  var myIds = tables.ClassMembers.filter(function (m) { return String(m.UserID) === String(user.UserID); })
    .map(function (m) { return String(m.ClassID); });
  return {
    classes: tables.Classes.map(function (cls) {
      var cid = String(cls.ClassID || '');
      return km_normalizeClass_(cls,
        tables.ClassMembers.filter(function (m) { return String(m.ClassID) === cid; }).length,
        myIds.indexOf(cid) >= 0);
    })
  };
}

function km_saveClass_(user, data) {
  km_requireAdmin_(user);
  var classId = km_clean_(data.classId, 100) || km_id_('cls');
  var className = km_clean_(data.className, 140);
  if (className.length < 3) throw km_err_('VALIDATION', 'Nama kelas minimal 3 karakter.');

  var existing = km_readTable_('Classes').filter(function (c) { return String(c.ClassID) === classId; })[0] || null;
  var pick = function (key, cleaner) {
    return data[key] !== undefined && data[key] !== '' ? cleaner(data[key]) : (existing ? String(existing[key] || '') : '');
  };
  var startDate = pick('startDate', function (v) { return km_dateOnly_(v); });
  var endDate = pick('endDate', function (v) { return km_dateOnly_(v); });
  var closeDate = pick('closeDate', function (v) { return km_dateOnly_(v); });
  if (startDate && endDate && endDate < startDate) {
    throw km_err_('VALIDATION', 'Tanggal berakhir tidak boleh sebelum tanggal mulai.');
  }
  var now = km_now_();
  var record = {
    ClassID: classId,
    ClassName: className,
    BatchNumber: Math.round(km_num_(data.batchNumber, 0, 9999, existing ? Number(existing.BatchNumber || 0) : 0)),
    ClassType: String(data.classType || (existing && existing.ClassType) || 'Batch') === 'Alumni' ? 'Alumni' : 'Batch',
    Description: km_clean_(data.description, 2000),
    MentorName: km_clean_(data.mentorName || (existing && existing.MentorName) || user.Name || 'Mentor', 100),
    StartDate: startDate,
    EndDate: endDate,
    CloseDate: closeDate,
    TargetPagesPerDay: Math.round(km_num_(data.targetPagesPerDay, 1, 500, KM_CONFIG.DAILY_TARGET_PAGES)),
    MinGradTasks: Math.round(km_num_(data.minGradTasks, 0, 100, 6)),
    MinGradPages: Math.round(km_num_(data.minGradPages, 0, 100000, 1000)),
    Status: data.status === 'Closed' ? 'Closed' : 'Active',
    CreatedAt: existing ? String(existing.CreatedAt || now) : now,
    UpdatedAt: now
  };
  km_saveRecord_('Classes', 'ClassID', record);
  return { _message: 'Kelas berhasil disimpan.', classItem: km_normalizeClass_(record, 0, false) };
}

function km_deleteClass_(user, data) {
  km_requireAdmin_(user);
  var classId = km_clean_(data.classId, 100);
  var taskIds = km_readTable_('Tasks').filter(function (t) { return String(t.ClassID) === classId; })
    .map(function (t) { return String(t.TaskID); });
  km_deleteWhere_('UserTasks', function (ut) { return taskIds.indexOf(String(ut.TaskID)) >= 0; });
  km_deleteWhere_('Tasks', function (t) { return String(t.ClassID) === classId; });
  km_deleteWhere_('ClassMembers', function (cm) { return String(cm.ClassID) === classId; });
  km_deleteWhere_('Classes', function (c) { return String(c.ClassID) === classId; });
  return { _message: 'Kelas dan tugas terkait telah dihapus.', deleted: true };
}

function km_joinClass_(user, data) {
  var classId = km_clean_(data.classId, 100);
  var cls = km_readTable_('Classes').filter(function (c) { return String(c.ClassID) === classId; })[0];
  if (!cls) throw km_err_('NOT_FOUND', 'Kelas tidak ditemukan.');
  if (km_isAlumniClass_(cls)) throw km_err_('FORBIDDEN', 'Pendaftaran ke Kelas Alumni dilakukan otomatis.');
  var today = km_todayWIB_();
  var closeDate = km_dateOnly_(cls.CloseDate);
  var endDate = km_dateOnly_(cls.EndDate);
  if (String(cls.Status) === 'Closed' || (closeDate && today >= closeDate) || (endDate && today > endDate)) {
    throw km_err_('CLOSED', 'Kelas sudah ditutup. Pendaftaran peserta baru tidak tersedia.');
  }
  var already = km_readTable_('ClassMembers').some(function (m) {
    return String(m.ClassID) === classId && String(m.UserID) === String(user.UserID);
  });
  if (!already) {
    km_saveRecord_('ClassMembers', 'EnrollmentID', {
      EnrollmentID: km_id_('enr'), ClassID: classId, UserID: String(user.UserID), JoinDate: km_now_(),
      BatchPagesRead: 0, BatchTasksCompleted: 0, GraduationStatus: 'InProgress',
      GraduatedAt: '', MigratedToAlumniAt: ''
    });
  }
  return { _message: 'Berhasil bergabung ke kelas!', joined: true };
}

function km_listClassMembers_(user, data) {
  var classId = km_clean_(data.classId, 100);
  var t = km_readTables_(['Classes', 'ClassMembers', 'Users', 'ReadingLogs', 'Tasks', 'UserTasks']);
  var cls = t.Classes.filter(function (c) { return String(c.ClassID) === classId; })[0];
  if (!cls) throw km_err_('NOT_FOUND', 'Kelas tidak ditemukan.');
  var isMember = t.ClassMembers.some(function (m) { return String(m.ClassID) === classId && String(m.UserID) === String(user.UserID); });
  if (!km_isAdmin_(user) && !isMember) throw km_err_('FORBIDDEN', 'Anda bukan anggota kelas ini.');

  var members = t.ClassMembers.filter(function (m) { return String(m.ClassID) === classId; }).map(function (m) {
    var person = t.Users.filter(function (u) { return String(u.UserID) === String(m.UserID); })[0];
    if (!person) return null;
    var pub = km_publicUser_(person);
    var prog = km_progressFor_(t, pub.userId, cls, 0);
    pub.enrollmentDate = String(m.JoinDate || '');
    pub.graduationStatus = String(m.GraduationStatus || 'InProgress');
    pub.pagesRead = prog.pages;
    pub.effectiveMinutes = prog.minutes;
    pub.tasksDone = prog.tasks;
    return pub;
  }).filter(Boolean);

  return {
    classItem: km_normalizeClass_(cls, members.length, isMember),
    members: members
  };
}

function km_leaderboard_(user, data) {
  var classId = km_clean_(data.classId, 100);
  var days = Math.round(km_num_(data.days, 7, 365, 30));
  var t = km_readTables_(['Users', 'ReadingLogs', 'ClassMembers', 'Classes', 'Tasks', 'UserTasks']);
  var cls = classId ? t.Classes.filter(function (c) { return String(c.ClassID) === classId; })[0] : null;
  if (classId && !cls) throw km_err_('NOT_FOUND', 'Kelas tidak ditemukan.');

  var candidates = null;
  if (classId) {
    candidates = t.ClassMembers.filter(function (m) { return String(m.ClassID) === classId; })
      .map(function (m) { return String(m.UserID); });
  }
  var board = t.Users
    .filter(function (u) { return !candidates || candidates.indexOf(String(u.UserID)) >= 0; })
    .map(function (u) {
      var uid = String(u.UserID);
      var prog = km_progressFor_(t, uid, cls, days);
      return {
        userId: uid,
        name: String(u.Name || 'Pembaca'),
        username: km_username_(u.Username, u.Name),
        avatarURL: String(u.AvatarURL || ''),
        pagesRead: prog.pages,
        effectiveMinutes: prog.minutes,
        sessionsCount: prog.sessions,
        tasksDone: prog.tasks,
        points: prog.pages
      };
    })
    .filter(function (row) { return cls || row.pagesRead > 0 || row.tasksDone > 0; })
    .sort(function (a, b) { return b.pagesRead - a.pagesRead || b.tasksDone - a.tasksDone || a.name.localeCompare(b.name); });

  board.forEach(function (item, idx) { item.rank = idx + 1; });
  return {
    title: cls ? String(cls.ClassName || 'Kelas') : 'Komunitas Kelas Membaca',
    days: days,
    leaderboard: board,
    classId: classId,
    isAlumni: cls ? km_isAlumniClass_(cls) : false,
    classItem: cls ? km_normalizeClass_(cls, candidates ? candidates.length : 0, false) : null
  };
}

/** Membuat 10 tugas terjadwal otomatis untuk kelas batch (idempoten). */
function km_generateClassTasks_(user, data) {
  km_requireAdmin_(user);
  var classId = km_clean_(data.classId, 100);
  var cls = km_readTable_('Classes').filter(function (c) { return String(c.ClassID) === classId; })[0];
  if (!cls) throw km_err_('NOT_FOUND', 'Kelas tidak ditemukan.');
  var start = km_dateOnly_(cls.StartDate);
  if (!start) throw km_err_('VALIDATION', 'Isi tanggal mulai kelas terlebih dahulu.');

  var existing = km_readTable_('Tasks').filter(function (t) { return String(t.ClassID) === classId; });
  if (existing.length) {
    return { _message: 'Kelas ini sudah memiliki ' + existing.length + ' tugas. Tidak ada tugas baru yang dibuat.', created: 0 };
  }
  var now = km_now_();
  var records = KM_TASK_BLUEPRINT.map(function (bp, idx) {
    return {
      TaskID: km_id_('tsk'),
      ClassID: classId,
      TaskNumber: idx + 1,
      Title: bp.title,
      Description: bp.description,
      ActiveDate: km_addDays_(start, bp.offset),
      Deadline: km_addDays_(start, bp.offset),
      FormJSON: JSON.stringify(bp.form),
      ValidationRuleJSON: JSON.stringify(bp.validationRule || { type: bp.type }),
      Status: 'Published',
      CreatedAt: now,
      UpdatedAt: now
    };
  });
  km_upsertMany_('Tasks', 'TaskID', records);
  return { _message: '10 tugas terjadwal berhasil dibuat untuk kelas ini.', created: records.length };
}

function km_listTasks_(user) {
  var tables = km_readTables_(['Tasks', 'Classes', 'ClassMembers', 'UserTasks']);
  var isAdmin = km_isAdmin_(user);
  var myIds = tables.ClassMembers.filter(function (m) { return String(m.UserID) === String(user.UserID); })
    .map(function (m) { return String(m.ClassID); });
  var mine = tables.UserTasks.filter(function (ut) { return String(ut.UserID) === String(user.UserID); });
  return {
    tasks: tables.Tasks.filter(function (t) {
      return isAdmin || (myIds.indexOf(String(t.ClassID)) >= 0 && String(t.Status) !== 'Draft');
    }).map(function (t) {
      var cls = tables.Classes.filter(function (c) { return String(c.ClassID) === String(t.ClassID); })[0];
      var sub = mine.filter(function (ut) { return String(ut.TaskID) === String(t.TaskID); })[0] || null;
      return km_taskForClient_(t, sub, cls ? { className: cls.ClassName } : null, tables.UserTasks);
    })
  };
}

function km_saveTask_(user, data) {
  km_requireAdmin_(user);
  var taskId = km_clean_(data.taskId, 100) || km_id_('tsk');
  var classId = km_clean_(data.classId, 100);
  var title = km_clean_(data.title, 180);
  if (!classId) throw km_err_('VALIDATION', 'Pilih kelas untuk tugas ini.');
  if (title.length < 3) throw km_err_('VALIDATION', 'Judul tugas minimal 3 karakter.');

  var form = km_normalizeForm_(data.form || []);
  var existing = km_readTable_('Tasks').filter(function (t) { return String(t.TaskID) === taskId; })[0];
  var now = km_now_();
  var activeDate = km_dateOnly_(data.activeDate || data.deadline);
  var rule = data.validationRule && typeof data.validationRule === 'object' ? data.validationRule : {};
  var record = {
    TaskID: taskId,
    ClassID: classId,
    TaskNumber: Math.round(km_num_(data.taskNumber, 1, 99, existing ? Number(existing.TaskNumber || 1) : 1)),
    Title: title,
    Description: km_clean_(data.description, 3000),
    ActiveDate: activeDate,
    Deadline: activeDate,
    FormJSON: JSON.stringify(form),
    ValidationRuleJSON: JSON.stringify({
      type: km_clean_(rule.type, 60),
      minPages: Math.round(km_num_(rule.minPages, 0, 100000, 0)),
      category: km_clean_(rule.category, 60),
      bookTitle: km_clean_(rule.bookTitle, 200),
      author: km_clean_(rule.author, 120)
    }),
    Status: ['Draft', 'Published', 'Closed'].indexOf(String(data.status)) >= 0 ? String(data.status) : 'Published',
    CreatedAt: existing ? String(existing.CreatedAt || now) : now,
    UpdatedAt: now
  };
  km_saveRecord_('Tasks', 'TaskID', record);
  return { _message: 'Tugas berhasil disimpan.', task: record };
}

function km_normalizeForm_(form) {
  var allowed = ['text', 'textarea', 'number', 'url', 'date', 'select', 'radio', 'checkbox'];
  if (!Array.isArray(form)) return [];
  var seen = {};
  return form.slice(0, 35).map(function (field, idx) {
    var id = km_clean_(field.id, 60).replace(/[^A-Za-z0-9_-]/g, '') || ('field_' + (idx + 1));
    if (seen[id]) id = id + '_' + (idx + 1);
    seen[id] = true;
    var type = allowed.indexOf(String(field.type)) >= 0 ? String(field.type) : 'text';
    var label = km_clean_(field.label, 140);
    if (!label) throw km_err_('VALIDATION', 'Setiap field pada form tugas wajib memiliki label.');
    var options = Array.isArray(field.options)
      ? field.options.slice(0, 30).map(function (o) { return km_clean_(o, 120); }).filter(Boolean)
      : [];
    if (['select', 'radio', 'checkbox'].indexOf(type) >= 0 && options.length < 2) {
      throw km_err_('VALIDATION', 'Field pilihan (' + label + ') wajib memiliki minimal 2 opsi.');
    }
    return {
      id: id, label: label, type: type, required: Boolean(field.required),
      options: options, placeholder: km_clean_(field.placeholder, 160)
    };
  });
}

function km_deleteTask_(user, data) {
  km_requireAdmin_(user);
  var taskId = km_clean_(data.taskId, 100);
  km_deleteWhere_('UserTasks', function (ut) { return String(ut.TaskID) === taskId; });
  km_deleteWhere_('Tasks', function (t) { return String(t.TaskID) === taskId; });
  return { _message: 'Tugas berhasil dihapus.', deleted: true };
}

function km_submitTask_(user, data) {
  var taskId = km_clean_(data.taskId, 100);
  var task = km_readTable_('Tasks').filter(function (t) { return String(t.TaskID) === taskId; })[0];
  if (!task) throw km_err_('NOT_FOUND', 'Tugas tidak ditemukan.');
  if (String(task.Status) === 'Closed') throw km_err_('CLOSED', 'Tugas sudah ditutup.');

  var today = km_todayWIB_();
  var activeDate = km_dateOnly_(task.ActiveDate || task.Deadline);
  var isAdmin = km_isAdmin_(user);
  if (!isAdmin && activeDate && today !== activeDate) {
    throw km_err_('CLOSED', 'Tugas hanya dapat dikerjakan pada tanggal aktifnya (00.00–24.00 WIB).');
  }
  var cls = km_readTable_('Classes').filter(function (c) { return String(c.ClassID) === String(task.ClassID); })[0];
  if (cls && !isAdmin) {
    var closeDate = km_dateOnly_(cls.CloseDate);
    if (String(cls.Status) === 'Closed' || (closeDate && today >= closeDate)) {
      throw km_err_('CLOSED', 'Kelas sudah ditutup. Data baru tidak dapat disimpan.');
    }
    var enrolled = km_readTable_('ClassMembers').some(function (m) {
      return String(m.ClassID) === String(task.ClassID) && String(m.UserID) === String(user.UserID);
    });
    if (!enrolled) throw km_err_('FORBIDDEN', 'Anda belum terdaftar di kelas ini. Gabung kelas terlebih dahulu.');
  }

  var form = km_parseJson_(task.FormJSON, []);
  var raw = data.answers && typeof data.answers === 'object' ? data.answers : {};
  var clean = {};
  form.forEach(function (field) {
    var val = raw[field.id];
    if (field.type === 'checkbox') {
      val = Array.isArray(val) ? val.map(function (v) { return km_clean_(v, 140); }).filter(Boolean) : [];
      if (field.options && field.options.length) val = val.filter(function (v) { return field.options.indexOf(v) >= 0; });
      if (field.required && val.length === 0) throw km_err_('VALIDATION', 'Field wajib diisi: ' + field.label);
    } else if (field.type === 'select' || field.type === 'radio') {
      val = km_clean_(val, 1000);
      if (field.required && !val) throw km_err_('VALIDATION', 'Field wajib diisi: ' + field.label);
      if (val && field.options && field.options.length && field.options.indexOf(val) < 0) {
        throw km_err_('VALIDATION', 'Nilai tidak valid untuk field: ' + field.label);
      }
    } else if (field.type === 'number') {
      val = km_clean_(val, 20);
      if (field.required && !val) throw km_err_('VALIDATION', 'Field wajib diisi: ' + field.label);
      if (val && !isFinite(Number(val))) throw km_err_('VALIDATION', 'Field ' + field.label + ' harus berupa angka.');
    } else {
      val = km_clean_(val, field.type === 'textarea' ? 4000 : 1000);
      if (field.required && !val) throw km_err_('VALIDATION', 'Field wajib diisi: ' + field.label);
      if (val && field.type === 'url' && !/^https?:\/\//i.test(val)) {
        throw km_err_('VALIDATION', 'Field ' + field.label + ' harus berupa tautan (https://).');
      }
    }
    clean[field.id] = val;
  });

  var existing = km_readTable_('UserTasks').filter(function (ut) {
    return String(ut.TaskID) === taskId && String(ut.UserID) === String(user.UserID);
  })[0];
  var resubmit = existing && String(existing.Status) === 'Reviewed';
  var record = {
    UserTaskID: existing ? String(existing.UserTaskID) : km_id_('ut'),
    UserID: String(user.UserID),
    TaskID: taskId,
    Status: 'Submitted',
    AnswersJSON: JSON.stringify(clean),
    Feedback: resubmit ? '' : (existing ? String(existing.Feedback || '') : ''),
    Score: resubmit ? '' : (existing && existing.Score !== undefined && existing.Score !== null ? existing.Score : ''),
    SubmittedAt: km_now_(),
    ReviewedAt: resubmit ? '' : (existing ? String(existing.ReviewedAt || '') : '')
  };
  km_saveRecord_('UserTasks', 'UserTaskID', record);
  return { _message: 'Jawaban tugas berhasil dikirim!', submission: record };
}

function km_listTaskSubmissions_(user, data) {
  km_requireAdmin_(user);
  var taskId = km_clean_(data.taskId, 100);
  var t = km_readTables_(['UserTasks', 'Users']);
  var usersById = {};
  t.Users.forEach(function (u) { usersById[String(u.UserID)] = km_privateUser_(u); });
  return {
    submissions: t.UserTasks.filter(function (ut) { return String(ut.TaskID) === taskId; }).map(function (ut) {
      var member = usersById[String(ut.UserID)] || { name: 'Anggota', email: '' };
      return {
        userTaskId: String(ut.UserTaskID),
        userId: String(ut.UserID),
        memberName: member.name,
        memberEmail: member.email,
        status: String(ut.Status || 'Submitted'),
        answers: km_parseJson_(ut.AnswersJSON, {}),
        feedback: String(ut.Feedback || ''),
        score: (ut.Score === '' || ut.Score === null || ut.Score === undefined) ? null : Number(ut.Score),
        submittedAt: String(ut.SubmittedAt || ''),
        reviewedAt: String(ut.ReviewedAt || '')
      };
    })
  };
}

function km_reviewSubmission_(user, data) {
  km_requireAdmin_(user);
  var userTaskId = km_clean_(data.userTaskId, 100);
  var sub = km_readTable_('UserTasks').filter(function (ut) { return String(ut.UserTaskID) === userTaskId; })[0];
  if (!sub) throw km_err_('NOT_FOUND', 'Data pengumpulan tugas tidak ditemukan.');
  var hasScore = !(data.score === '' || data.score === null || data.score === undefined);
  var saved = km_saveRecord_('UserTasks', 'UserTaskID', Object.assign({}, sub, {
    Status: 'Reviewed',
    Score: hasScore ? Math.round(km_num_(data.score, 0, 100, 0)) : '',
    Feedback: km_clean_(data.feedback, 2500),
    ReviewedAt: km_now_()
  }));
  return { _message: 'Penilaian dan feedback berhasil disimpan.', submission: saved };
}

/* ==========================================================================
 * LIFECYCLE BATCH: EVALUASI KELULUSAN & MIGRASI KE KELAS ALUMNI
 * ========================================================================== */

function km_runLifecycle_(actor) {
  if (actor) km_requireAdmin_(actor);
  var t = km_readTables_(['Classes', 'ClassMembers', 'Users', 'ReadingLogs', 'Tasks', 'UserTasks']);
  var today = km_todayWIB_();
  var now = km_now_();
  var due = t.Classes.filter(function (c) {
    var end = km_dateOnly_(c.EndDate);
    // Kelas yang sudah ditutup manual tetap diproses; anggota yang sudah bermigrasi dilewati.
    return !km_isAlumniClass_(c) && end && today > end;
  });
  var summary = { classesProcessed: 0, membersEvaluated: 0, graduated: 0, migrated: 0 };
  if (!due.length) {
    return { _message: 'Tidak ada kelas batch yang perlu diproses hari ini.', summary: summary };
  }

  var alumni = t.Classes.filter(km_isAlumniClass_)[0];
  if (!alumni) {
    alumni = km_saveRecord_('Classes', 'ClassID', {
      ClassID: 'cls_alumni', ClassName: 'Kelas Alumni', BatchNumber: 0, ClassType: 'Alumni',
      Description: 'Ruang berkelanjutan bagi alumni Kelas Membaca.', MentorName: 'Mentor Literasi',
      StartDate: '', EndDate: '', CloseDate: '', TargetPagesPerDay: KM_CONFIG.DAILY_TARGET_PAGES,
      MinGradTasks: 0, MinGradPages: 0, Status: 'Active', CreatedAt: now, UpdatedAt: now
    });
  }
  var alumniEnrolled = {};
  t.ClassMembers.forEach(function (m) {
    if (String(m.ClassID) === String(alumni.ClassID)) alumniEnrolled[String(m.UserID)] = true;
  });

  due.forEach(function (cls) {
    summary.classesProcessed++;
    t.ClassMembers.filter(function (m) {
      return String(m.ClassID) === String(cls.ClassID) && !m.MigratedToAlumniAt;
    }).forEach(function (m) {
      var uid = String(m.UserID);
      var prog = km_progressFor_(t, uid, cls, 0);
      var graduated = prog.pages >= Number(cls.MinGradPages || 1000) && prog.tasks >= Number(cls.MinGradTasks || 6);
      summary.membersEvaluated++;
      if (graduated) summary.graduated++;
      km_saveRecord_('ClassMembers', 'EnrollmentID', Object.assign({}, m, {
        BatchPagesRead: prog.pages,
        BatchTasksCompleted: prog.tasks,
        GraduationStatus: graduated ? 'Lulus' : 'Tidak Lulus',
        GraduatedAt: now,
        MigratedToAlumniAt: now
      }));
      if (!alumniEnrolled[uid]) {
        km_saveRecord_('ClassMembers', 'EnrollmentID', {
          EnrollmentID: km_id_('enr'), ClassID: String(alumni.ClassID), UserID: uid, JoinDate: now,
          BatchPagesRead: 0, BatchTasksCompleted: 0, GraduationStatus: 'Alumni', GraduatedAt: '', MigratedToAlumniAt: ''
        });
        alumniEnrolled[uid] = true;
        summary.migrated++;
      }
      var user = t.Users.filter(function (u) { return String(u.UserID) === uid; })[0];
      if (user && !user.AlumniJoinDate) {
        km_saveRecord_('Users', 'UserID', Object.assign({}, user, { AlumniJoinDate: now, UpdatedAt: now }));
      }
    });
    km_saveRecord_('Classes', 'ClassID', Object.assign({}, cls, { Status: 'Closed', UpdatedAt: now }));
  });
  return {
    _message: 'Evaluasi selesai: ' + summary.classesProcessed + ' kelas diproses, ' + summary.migrated + ' peserta dipindah ke Kelas Alumni.',
    summary: summary
  };
}

/* ==========================================================================
 * ADMIN: MANAJEMEN ANGGOTA, PANTAU PROGRES, EKSPOR & IMPOR DATA
 * ========================================================================== */

function km_listUsers_(user, data) {
  km_requireAdmin_(user);
  var q = km_clean_(data.query, 120).toLowerCase();
  var users = km_readTable_('Users').map(km_privateUser_).filter(function (u) {
    return !q || (u.name + ' ' + u.email + ' ' + u.username).toLowerCase().indexOf(q) >= 0;
  });
  return { users: users };
}

function km_saveUser_(actor, data) {
  km_requireAdmin_(actor);
  var userId = km_clean_(data.userId, 100);
  var users = km_readTable_('Users');
  var existing = userId ? users.filter(function (u) { return String(u.UserID) === userId; })[0] : null;
  if (userId && !existing) throw km_err_('NOT_FOUND', 'Anggota tidak ditemukan.');

  var name = km_clean_(data.name, 100);
  var email = km_email_(data.email);
  var username = km_username_(data.username, name);
  var role = String(data.role || 'Member') === 'Admin' ? 'Admin' : 'Member';
  var password = String(data.password || '');

  if (name.length < 2) throw km_err_('VALIDATION', 'Nama anggota minimal 2 karakter.');
  if (!km_validEmail_(email)) throw km_err_('VALIDATION', 'Format email belum valid.');
  if (username.length < 3) throw km_err_('VALIDATION', 'Username minimal 3 karakter.');
  if (users.some(function (u) { return km_email_(u.Email) === email && String(u.UserID) !== userId; })) {
    throw km_err_('EMAIL_TAKEN', 'Email sudah digunakan oleh akun lain.');
  }
  if (users.some(function (u) {
    return String(u.UserID) !== userId && km_username_(u.Username, u.Name) === username;
  })) {
    throw km_err_('USERNAME_TAKEN', 'Username sudah dipakai oleh akun lain.');
  }
  if (!existing && !password) throw km_err_('VALIDATION', 'Kata sandi awal wajib diisi untuk akun baru.');
  if (password) km_validatePassword_(password);
  if (existing && String(existing.UserID) === String(actor.UserID) && role !== 'Admin') {
    throw km_err_('VALIDATION', 'Anda tidak dapat menurunkan peran akun Anda sendiri.');
  }

  var salt = password ? km_salt_() : (existing ? String(existing.PasswordSalt || '') : km_salt_());
  var now = km_now_();
  var record = {
    UserID: existing ? String(existing.UserID) : km_id_('usr'),
    Name: name,
    Username: username,
    Email: email,
    PasswordHash: password ? km_hash_(password, salt) : String(existing.PasswordHash || ''),
    PasswordSalt: salt,
    Role: role,
    JoinDate: existing ? String(existing.JoinDate || now) : now,
    AlumniJoinDate: existing ? String(existing.AlumniJoinDate || '') : '',
    WaSettings: km_clean_(data.waSettings !== undefined ? data.waSettings : (existing ? existing.WaSettings : ''), 60),
    AvatarURL: existing ? String(existing.AvatarURL || '') : '',
    Bio: km_clean_(data.bio || (existing ? existing.Bio : 'Peserta Kelas Membaca'), 300),
    ResetToken: '',
    AuthVersion: existing ? String(Number(existing.AuthVersion || 1) + (password ? 1 : 0)) : '1',
    UpdatedAt: now
  };
  var saved = km_saveRecord_('Users', 'UserID', record);
  return { _message: 'Data akun anggota berhasil disimpan.', user: km_privateUser_(saved) };
}

function km_deleteUser_(actor, data) {
  km_requireAdmin_(actor);
  var userId = km_clean_(data.userId, 100);
  if (userId === String(actor.UserID)) throw km_err_('VALIDATION', 'Anda tidak dapat menghapus akun Anda sendiri.');

  var t = km_readTables_(['ReadingBooks', 'ReadingLogs']);
  t.ReadingBooks.filter(function (b) { return String(b.UserID) === userId; })
    .forEach(function (b) { km_trashCoverFile_(b.CoverFileID); });

  var logIds = t.ReadingLogs.filter(function (r) { return String(r.UserID) === userId; })
    .map(function (r) { return String(r.LogID); });
  km_deleteWhere_('Comments', function (r) {
    return String(r.UserID) === userId || logIds.indexOf(String(r.LogID)) >= 0;
  });
  km_deleteWhere_('ReadingLogs', function (r) { return String(r.UserID) === userId; });
  km_deleteWhere_('ReadingBooks', function (r) { return String(r.UserID) === userId; });
  km_deleteWhere_('Friends', function (r) { return String(r.UserID) === userId || String(r.FriendUserID) === userId; });
  km_deleteWhere_('ClassMembers', function (r) { return String(r.UserID) === userId; });
  km_deleteWhere_('UserTasks', function (r) { return String(r.UserID) === userId; });
  km_deleteWhere_('Users', function (r) { return String(r.UserID) === userId; });
  return { _message: 'Akun anggota beserta riwayatnya telah dihapus.', deleted: true };
}

function km_memberProgress_(actor, data) {
  km_requireAdmin_(actor);
  var targetId = km_clean_(data.userId, 100);
  var t = km_readTables_(['Users', 'ReadingBooks', 'ReadingLogs', 'ClassMembers', 'Classes', 'Comments']);
  var target = t.Users.filter(function (u) { return String(u.UserID) === targetId; })[0];
  if (!target) throw km_err_('NOT_FOUND', 'Anggota tidak ditemukan.');
  var usersById = {};
  usersById[targetId] = km_publicUser_(target);
  var commentsByLog = km_commentsByLog_(t, usersById);
  var coverMap = {};
  t.ReadingBooks.forEach(function (b) { if (b.CoverURL) coverMap[String(b.BookID)] = String(b.CoverURL); });

  var logs = t.ReadingLogs.filter(function (l) { return String(l.UserID) === targetId; })
    .map(function (l) { return km_normalizeLog_(l, usersById, commentsByLog, coverMap); })
    .sort(function (a, b) { return (b.date + b.createdAt).localeCompare(a.date + a.createdAt); });
  var books = t.ReadingBooks.filter(function (b) { return String(b.UserID) === targetId; })
    .map(function (b) { return km_normalizeBook_(b, usersById); });
  var classes = t.ClassMembers.filter(function (m) { return String(m.UserID) === targetId; }).map(function (m) {
    var cls = t.Classes.filter(function (c) { return String(c.ClassID) === String(m.ClassID); })[0];
    return { classId: String(m.ClassID), className: cls ? String(cls.ClassName) : '-', graduationStatus: String(m.GraduationStatus || 'InProgress') };
  });
  return {
    user: km_privateUser_(target),
    logs: logs,
    books: books,
    classes: classes,
    totals: {
      pages: logs.reduce(function (s, l) { return s + Number(l.pagesRead || 0); }, 0),
      minutes: logs.reduce(function (s, l) { return s + Number(l.effectiveMinutes || 0); }, 0),
      sessions: logs.length,
      booksFinished: books.filter(function (b) { return b.status === 'Finished'; }).length
    }
  };
}

var KM_EXPORT_HIDDEN_COLUMNS = ['PasswordHash', 'PasswordSalt', 'ResetToken'];

function km_exportAllData_(user) {
  km_requireAdmin_(user);
  var names = Object.keys(KM_CONFIG.TABLES);
  var tables = km_readTables_(names);
  var clone = {};
  names.forEach(function (name) {
    clone[name] = tables[name].map(function (row) {
      var copy = {};
      Object.keys(row).forEach(function (k) {
        if (name === 'Users' && KM_EXPORT_HIDDEN_COLUMNS.indexOf(k) >= 0) return;
        copy[k] = row[k];
      });
      return copy;
    });
  });
  return {
    _message: 'Database server berhasil diekspor (kata sandi tidak ikut diekspor).',
    exportedAt: km_now_(),
    version: KM_CONFIG.VERSION,
    tables: clone
  };
}

/**
 * Impor (upsert) dari berkas JSON hasil ekspor. Tidak menghapus data yang tidak ada di berkas.
 * Struktur divalidasi: tables harus objek; setiap tabel berupa array of object dengan kolom kunci.
 */
function km_importAllData_(user, data) {
  km_requireAdmin_(user);
  var payload = data.tables && typeof data.tables === 'object' ? data.tables : null;
  if (!payload) throw km_err_('VALIDATION', 'Berkas impor tidak valid: properti "tables" tidak ditemukan.');
  var names = Object.keys(KM_CONFIG.TABLES);
  var total = 0;
  var report = {};
  names.forEach(function (name) {
    if (!Array.isArray(payload[name])) return;
    var headers = KM_CONFIG.TABLES[name];
    var keyField = headers[0];
    var rows = payload[name].filter(function (r) { return r && typeof r === 'object' && !Array.isArray(r); });
    if (rows.length > 20000) throw km_err_('VALIDATION', 'Tabel ' + name + ' terlalu besar (maks 20.000 baris).');
    var clean = rows.filter(function (r) { return String(r[keyField] || '').trim() !== ''; }).map(function (r) {
      var rec = {};
      headers.forEach(function (h) {
        if (r[h] !== undefined) rec[h] = (typeof r[h] === 'string') ? km_clean_(r[h], 5000) : r[h];
      });
      rec[keyField] = String(r[keyField]).trim();
      if (name === 'Users') {
        rec.Role = String(rec.Role || 'Member') === 'Admin' ? 'Admin' : 'Member';
        rec.UpdatedAt = km_now_();
      }
      return rec;
    });
    var saved = km_upsertMany_(name, keyField, clean);
    report[name] = saved;
    total += saved;
  });
  if (!total) throw km_err_('VALIDATION', 'Tidak ada tabel yang dikenali pada berkas impor.');
  return { _message: 'Impor selesai: ' + total + ' baris diperbarui/ditambahkan.', report: report };
}
