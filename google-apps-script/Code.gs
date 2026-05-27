/**
 * VocabMaster - Google Apps Script Backend
 *
 * Deploy this as a Web App in the Google Sheet to enable progress sync.
 *
 * Setup Instructions:
 * 1. Open the Google Sheet: https://docs.google.com/spreadsheets/d/1uyQVcj_zcrrWyBVZSfYmXRBOqLp6rILGYNWafApuwpo/
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code and paste this entire file
 * 4. Click Deploy > New deployment
 * 5. Select type: Web app
 * 6. Set "Execute as": Me
 * 7. Set "Who has access": Anyone
 * 8. Click Deploy and copy the Web App URL
 * 9. Paste the URL into VocabMaster Settings > Google Sheet Sync > Apps Script Web App URL
 */

const PROGRESS_SHEET_NAME = 'Progress';
const STUDY_LOG_SHEET_NAME = 'StudyLog';
const META_SHEET_NAME = 'Meta';
const SCRIPT_VERSION = 'v3-meta-sheet-2026-05-27';

function doGet(e) {
  const action = e.parameter.action || 'ping';

  if (action === 'ping') {
    return jsonResponse({ status: 'ok', message: 'VocabMaster API is running', version: SCRIPT_VERSION });
  }

  if (action === 'getProgress') {
    return jsonResponse(getProgress());
  }

  return jsonResponse({ error: 'Unknown action' });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'saveProgress') {
      return jsonResponse(saveProgress(data.user, data.progress, data.studyDays, data.todayPlan));
    }

    return jsonResponse({ error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function getProgress() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PROGRESS_SHEET_NAME);

  if (!sheet) {
    return { progress: {}, studyDays: [] };
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { progress: {}, studyDays: [] };

  const progress = {};
  // Header: WordID, Level, LastReview, NextReview, Correct, Incorrect, EaseFactor
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    progress[row[0]] = {
      level: row[1] || 0,
      lastReview: dateToStr(row[2]),
      nextReview: dateToStr(row[3]),
      correct: row[4] || 0,
      incorrect: row[5] || 0,
      easeFactor: row[6] || 2.5
    };
  }

  // Get study days from log sheet
  let studyDays = [];
  const logSheet = ss.getSheetByName(STUDY_LOG_SHEET_NAME);
  if (logSheet) {
    const logData = logSheet.getDataRange().getValues();
    for (let i = 1; i < logData.length; i++) {
      const s = dateToStr(logData[i][0]);
      if (s) studyDays.push(s);
    }
  }

  // Read today's plan from Meta sheet (B1 cell contains JSON)
  let todayPlan = null;
  const metaSheet = ss.getSheetByName(META_SHEET_NAME);
  if (metaSheet) {
    const planJson = metaSheet.getRange('B1').getValue();
    if (planJson) {
      try { todayPlan = JSON.parse(planJson); } catch (e) {}
    }
  }

  return { progress, studyDays, todayPlan };
}

// Convert anything (Date / string / empty) to "YYYY-MM-DD" Taiwan-timezone string
function dateToStr(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Taipei', 'yyyy-MM-dd');
  }
  return String(val);
}

function saveProgress(user, progressData, studyDays, todayPlan) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create or clear Progress sheet
  let sheet = ss.getSheetByName(PROGRESS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PROGRESS_SHEET_NAME);
  } else {
    sheet.clearContents();
  }

  // Write headers
  sheet.getRange(1, 1, 1, 8).setValues([[
    'WordID', 'Level', 'LastReview', 'NextReview', 'Correct', 'Incorrect', 'EaseFactor', 'User'
  ]]);

  // Style headers
  const headerRange = sheet.getRange(1, 1, 1, 8);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4f46e5');
  headerRange.setFontColor('#ffffff');

  // Force LastReview (col 3) and NextReview (col 4) to plain text so
  // Google Sheets won't auto-convert "2024-05-27" into a Date object.
  sheet.getRange(2, 3, sheet.getMaxRows() - 1, 2).setNumberFormat('@');

  // Write progress data
  const rows = [];
  for (const [wordId, p] of Object.entries(progressData)) {
    rows.push([
      parseInt(wordId),
      p.level || 0,
      p.lastReview || '',
      p.nextReview || '',
      p.correct || 0,
      p.incorrect || 0,
      p.easeFactor || 2.5,
      user
    ]);
  }

  if (rows.length > 0) {
    rows.sort((a, b) => a[0] - b[0]);
    sheet.getRange(2, 1, rows.length, 8).setValues(rows);
  }

  // Save study log
  let logSheet = ss.getSheetByName(STUDY_LOG_SHEET_NAME);
  if (!logSheet) {
    logSheet = ss.insertSheet(STUDY_LOG_SHEET_NAME);
  } else {
    logSheet.clearContents();
  }

  logSheet.getRange(1, 1, 1, 3).setValues([['Date', 'User', 'WordsStudied']]);
  const logHeaderRange = logSheet.getRange(1, 1, 1, 3);
  logHeaderRange.setFontWeight('bold');
  logHeaderRange.setBackground('#4f46e5');
  logHeaderRange.setFontColor('#ffffff');

  // Force Date column to plain text (prevents Date object auto-conversion)
  logSheet.getRange(2, 1, logSheet.getMaxRows() - 1, 1).setNumberFormat('@');

  if (studyDays && studyDays.length > 0) {
    const logRows = studyDays.map(day => {
      const count = Object.values(progressData).filter(p => p.lastReview === day).length;
      return [day, user, count];
    });
    logRows.sort((a, b) => a[0].localeCompare(b[0]));
    logSheet.getRange(2, 1, logRows.length, 3).setValues(logRows);
  }

  // Persist today's plan to Meta sheet so it's shared across devices
  if (todayPlan && todayPlan.date) {
    let metaSheet = ss.getSheetByName(META_SHEET_NAME);
    if (!metaSheet) metaSheet = ss.insertSheet(META_SHEET_NAME);
    metaSheet.getRange('A1').setValue('todayPlan');
    metaSheet.getRange('B1').setNumberFormat('@').setValue(JSON.stringify(todayPlan));
  }

  return {
    status: 'ok',
    message: `Saved ${rows.length} word records and ${(studyDays || []).length} study days`,
    timestamp: new Date().toISOString()
  };
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// Test function - run this in Apps Script editor to verify setup
// After running, the Sheet should have: Progress / StudyLog / Meta tabs
function testSetup() {
  const todayPlan = {
    date: '2026-05-27',
    dueIds: [],
    newIds: [1, 5, 10, 20, 50]
  };
  const result = saveProgress('test_user', {
    '1': { level: 2, lastReview: '2026-05-27', nextReview: '2026-05-29', correct: 3, incorrect: 1, easeFactor: 2.5 }
  }, ['2026-05-27'], todayPlan);
  Logger.log(result);
  Logger.log('Check the Google Sheet — you should now see a Meta tab.');
}
