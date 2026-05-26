/* =============================================
   VocabMaster - Spaced Repetition Vocabulary App
   ============================================= */

(function () {
  'use strict';

  // ===== CONFIG =====
  const CONFIG = {
    VALID_USER: 'Lyan_Yeh',
    DEFAULT_PASS_HASH: null, // computed on init
    DAILY_NEW_WORDS: 30,
    STORAGE_KEY: 'vocabmaster_data',
    SESSION_KEY: 'vocabmaster_session',
    SETTINGS_KEY: 'vocabmaster_settings',
    // Spaced repetition intervals (in days) based on Ebbinghaus forgetting curve
    INTERVALS: [0, 1, 2, 4, 7, 15, 30],
    MAX_LEVEL: 6
  };

  // ===== SIMPLE HASH =====
  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'vocabmaster_salt_2024');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ===== STATE =====
  let words = [];
  let progress = {};
  let settings = {};
  let sessionWords = [];
  let currentWordIndex = 0;
  let currentMode = '';
  let sessionResults = { correct: 0, incorrect: 0, total: 0 };

  // ===== INITIALIZATION =====
  async function init() {
    CONFIG.DEFAULT_PASS_HASH = await hashPassword('710415');
    loadSettings();
    loadProgress();
    await loadWords();
    setupEventListeners();
    checkSession();
    populateVoices();
  }

  async function loadWords() {
    try {
      const resp = await fetch('data/words.json');
      words = await resp.json();
    } catch (e) {
      console.error('Failed to load words:', e);
      showToast('Failed to load vocabulary data');
    }
  }

  function loadProgress() {
    try {
      const stored = localStorage.getItem(CONFIG.STORAGE_KEY);
      progress = stored ? JSON.parse(stored) : {};
    } catch {
      progress = {};
    }
  }

  function saveProgress() {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(progress));
  }

  function loadSettings() {
    try {
      const stored = localStorage.getItem(CONFIG.SETTINGS_KEY);
      settings = stored ? JSON.parse(stored) : {};
    } catch {
      settings = {};
    }
    if (!settings.dailyNew) settings.dailyNew = CONFIG.DAILY_NEW_WORDS;
    if (!settings.speechSpeed) settings.speechSpeed = 0.9;
    if (!settings.passwordHash) settings.passwordHash = null;
    if (!settings.gasUrl) settings.gasUrl = 'https://script.google.com/macros/s/AKfycbyJ6GNAMzNc71OHAx7qymFq6iR6PGFSmXgFV9SU-8gMPKBg4mp7SY0NXY6rndBFV2-0/exec';
  }

  function saveSettings() {
    localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(settings));
  }

  function checkSession() {
    const session = sessionStorage.getItem(CONFIG.SESSION_KEY);
    if (session === 'active') {
      showApp();
    }
  }

  // ===== AUTH =====
  async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');

    if (username !== CONFIG.VALID_USER) {
      errorEl.textContent = 'Invalid username';
      errorEl.classList.remove('hidden');
      return;
    }

    const hash = await hashPassword(password);
    const validHash = settings.passwordHash || CONFIG.DEFAULT_PASS_HASH;

    if (hash !== validHash) {
      errorEl.textContent = 'Invalid password';
      errorEl.classList.remove('hidden');
      return;
    }

    errorEl.classList.add('hidden');
    sessionStorage.setItem(CONFIG.SESSION_KEY, 'active');
    showApp();
    // After login: silently pull progress from Google Sheet and merge
    syncFromSheet(true);
  }

  function handleLogout() {
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
    document.getElementById('login-screen').classList.add('active');
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
    document.getElementById('main-app').classList.remove('active');
    document.getElementById('password').value = '';
  }

  function showApp() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('main-app').classList.add('active');
    navigateTo('dashboard');
  }

  // ===== SPACED REPETITION =====
  function getWordProgress(wordId) {
    if (!progress[wordId]) {
      progress[wordId] = {
        level: 0,
        lastReview: null,
        nextReview: null,
        correct: 0,
        incorrect: 0,
        easeFactor: 2.5
      };
    }
    return progress[wordId];
  }

  function updateWordProgress(wordId, quality) {
    // quality: 0=forgot, 1=hard, 2=good, 3=easy
    const p = getWordProgress(wordId);
    const today = getTodayStr();

    p.lastReview = today;

    if (quality === 0) {
      p.level = 0;
      p.incorrect++;
      p.easeFactor = Math.max(1.3, p.easeFactor - 0.3);
    } else if (quality === 1) {
      p.level = Math.max(0, p.level - 1);
      p.correct++;
      p.easeFactor = Math.max(1.3, p.easeFactor - 0.15);
    } else if (quality === 2) {
      p.level = Math.min(CONFIG.MAX_LEVEL, p.level + 1);
      p.correct++;
    } else {
      p.level = Math.min(CONFIG.MAX_LEVEL, p.level + 2);
      p.correct++;
      p.easeFactor = Math.min(3.0, p.easeFactor + 0.15);
    }

    const interval = CONFIG.INTERVALS[Math.min(p.level, CONFIG.INTERVALS.length - 1)];
    const adjustedInterval = Math.round(interval * p.easeFactor / 2.5);
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + adjustedInterval);
    p.nextReview = formatDate(nextDate);

    saveProgress();
    recordStudyDay(today);
  }

  function getTodayStr() {
    return formatDate(new Date());
  }

  function formatDate(d) {
    return d.toISOString().split('T')[0];
  }

  function isDueForReview(wordId) {
    const p = progress[wordId];
    if (!p || !p.nextReview) return false;
    return p.nextReview <= getTodayStr();
  }

  function isNewWord(wordId) {
    return !progress[wordId] || progress[wordId].level === 0 && !progress[wordId].lastReview;
  }

  function isMastered(wordId) {
    const p = progress[wordId];
    return p && p.level >= CONFIG.MAX_LEVEL;
  }

  function isLearning(wordId) {
    const p = progress[wordId];
    return p && p.level > 0 && p.level < CONFIG.MAX_LEVEL && p.lastReview;
  }

  function getTodayWords() {
    const today = getTodayStr();
    const dueWords = words.filter(w => isDueForReview(w.id));
    const newWordsToday = words.filter(w => isNewWord(w.id));

    const todayStudied = Object.values(progress).filter(
      p => p.lastReview === today && !p.nextReview
    ).length;

    const newCount = Math.min(
      settings.dailyNew - getNewWordsStudiedToday(),
      newWordsToday.length
    );

    shuffleArray(newWordsToday);
    return {
      due: dueWords,
      new: newWordsToday.slice(0, Math.max(0, newCount)),
      newTotal: newWordsToday.length
    };
  }

  function getNewWordsStudiedToday() {
    const today = getTodayStr();
    return Object.entries(progress).filter(([, p]) => {
      return p.lastReview === today && p.correct + p.incorrect === 1;
    }).length;
  }

  // ===== STUDY STREAK =====
  function recordStudyDay(dateStr) {
    if (!progress._studyDays) progress._studyDays = [];
    if (!progress._studyDays.includes(dateStr)) {
      progress._studyDays.push(dateStr);
      saveProgress();
    }
  }

  function getStreak() {
    if (!progress._studyDays || progress._studyDays.length === 0) return 0;
    const days = [...progress._studyDays].sort().reverse();
    const today = getTodayStr();
    let streak = 0;
    let checkDate = new Date(today);

    if (days[0] !== today) {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (days[0] !== formatDate(yesterday)) return 0;
      checkDate = yesterday;
    }

    for (let i = 0; i < 365; i++) {
      const dateStr = formatDate(checkDate);
      if (days.includes(dateStr)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  }

  // ===== NAVIGATION =====
  function navigateTo(page) {
    document.querySelectorAll('.page').forEach(p => {
      p.classList.remove('active');
      p.classList.add('hidden');
    });
    const target = document.getElementById(`page-${page}`);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('active');
    }

    document.querySelectorAll('.bottom-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === page);
    });

    if (page === 'dashboard') renderDashboard();
    if (page === 'wordlist') renderWordList();
    if (page === 'settings') renderSettings();
  }

  // ===== DASHBOARD =====
  function renderDashboard() {
    const today = getTodayStr();
    const totalWords = words.length;
    const learned = words.filter(w => isLearning(w.id) || isMastered(w.id)).length;
    const mastered = words.filter(w => isMastered(w.id)).length;
    const todayData = getTodayWords();
    const dueCount = todayData.due.length;

    document.getElementById('stat-total').textContent = totalWords;
    document.getElementById('stat-learned').textContent = learned;
    document.getElementById('stat-review').textContent = dueCount;
    document.getElementById('stat-mastered').textContent = mastered;

    const pct = totalWords > 0 ? Math.round((mastered / totalWords) * 100) : 0;
    document.getElementById('overall-progress-bar').style.width = pct + '%';
    document.getElementById('overall-progress-text').textContent = pct + '%';

    document.getElementById('today-new-count').textContent = todayData.new.length;
    document.getElementById('today-due-count').textContent = dueCount;

    document.getElementById('dashboard-date').textContent =
      new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const streak = getStreak();
    document.getElementById('streak-count').textContent = streak;
    document.getElementById('streak-icon').textContent = streak > 0 ? '🔥' : '❄️';

    renderHeatmap();
  }

  function renderHeatmap() {
    const heatmap = document.getElementById('heatmap');
    heatmap.innerHTML = '';
    const today = new Date();
    const studyDays = progress._studyDays || [];

    for (let i = 27; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = formatDate(d);
      const dayProgress = Object.entries(progress).filter(
        ([k, p]) => k !== '_studyDays' && p.lastReview === dateStr
      ).length;

      const el = document.createElement('div');
      el.className = 'heatmap-day';
      if (studyDays.includes(dateStr)) {
        if (dayProgress >= 40) el.className += ' level-4';
        else if (dayProgress >= 25) el.className += ' level-3';
        else if (dayProgress >= 10) el.className += ' level-2';
        else el.className += ' level-1';
      }
      el.title = `${dateStr}: ${dayProgress} words`;
      heatmap.appendChild(el);
    }
  }

  // ===== PRACTICE =====
  function startPractice(mode) {
    const todayData = getTodayWords();
    sessionWords = [...todayData.due, ...todayData.new];

    if (sessionWords.length === 0) {
      showToast('No words to practice today! All caught up! 🎉');
      return;
    }

    shuffleArray(sessionWords);
    currentWordIndex = 0;
    currentMode = mode;
    sessionResults = { correct: 0, incorrect: 0, total: sessionWords.length };

    navigateTo('practice');
    document.querySelectorAll('.practice-mode').forEach(m => m.classList.add('hidden'));
    document.getElementById(`mode-${mode}`).classList.remove('hidden');
    document.getElementById('practice-total').textContent = sessionWords.length;

    showPracticeWord();
  }

  function showPracticeWord() {
    if (currentWordIndex >= sessionWords.length) {
      showSessionComplete();
      return;
    }

    const word = sessionWords[currentWordIndex];
    document.getElementById('practice-current').textContent = currentWordIndex + 1;
    const pct = (currentWordIndex / sessionWords.length) * 100;
    document.getElementById('practice-progress-fill').style.width = pct + '%';

    if (currentMode === 'flashcard') renderFlashcard(word);
    else if (currentMode === 'choice') renderMultipleChoice(word);
    else if (currentMode === 'spelling') renderSpelling(word);
    else if (currentMode === 'listening') renderListening(word);
  }

  function nextWord() {
    currentWordIndex++;
    showPracticeWord();
  }

  // -- Flashcard Mode --
  function renderFlashcard(word) {
    const card = document.getElementById('flashcard');
    card.classList.remove('flipped');

    document.getElementById('fc-word').textContent = word.word;
    document.getElementById('fc-word-back').textContent = word.word;
    document.getElementById('fc-phonetic').textContent = word.phonetic;
    document.getElementById('fc-pos').textContent = word.pos;
    document.getElementById('fc-meaning').textContent = word.meaning;
    document.getElementById('fc-example').textContent = word.example;
  }

  function flipCard() {
    const card = document.getElementById('flashcard');
    card.classList.toggle('flipped');
    if (card.classList.contains('flipped')) {
      speak(sessionWords[currentWordIndex].word);
    }
  }

  function rateFlashcard(quality) {
    const card = document.getElementById('flashcard');
    if (!card.classList.contains('flipped')) {
      flipCard();
      return;
    }
    const word = sessionWords[currentWordIndex];
    updateWordProgress(word.id, quality);
    if (quality >= 2) sessionResults.correct++;
    else sessionResults.incorrect++;
    nextWord();
  }

  // -- Multiple Choice Mode --
  function renderMultipleChoice(word) {
    document.getElementById('mc-word').textContent = word.word;
    document.getElementById('mc-phonetic').textContent = word.phonetic;
    document.getElementById('mc-feedback').classList.add('hidden');
    document.getElementById('mc-next').classList.add('hidden');

    const choices = generateChoices(word, 4);
    const container = document.getElementById('mc-choices');
    container.innerHTML = '';

    choices.forEach(choice => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = choice.meaning;
      btn.addEventListener('click', () => handleChoiceAnswer(word, choice, btn));
      container.appendChild(btn);
    });

    speak(word.word);
  }

  function handleChoiceAnswer(word, choice, btn) {
    const correct = choice.id === word.id;
    const feedbackEl = document.getElementById('mc-feedback');
    const feedbackText = document.getElementById('mc-feedback-text');
    const feedbackExample = document.getElementById('mc-feedback-example');

    document.querySelectorAll('.choice-btn').forEach(b => {
      b.classList.add('disabled');
      if (b.textContent === word.meaning) b.classList.add('correct');
    });

    if (correct) {
      btn.classList.add('correct');
      feedbackText.textContent = '✓ Correct!';
      feedbackEl.style.background = 'var(--success-bg)';
      updateWordProgress(word.id, 2);
      sessionResults.correct++;
    } else {
      btn.classList.add('wrong');
      feedbackText.textContent = `✗ The correct answer is: ${word.meaning}`;
      feedbackEl.style.background = 'var(--danger-bg)';
      updateWordProgress(word.id, 0);
      sessionResults.incorrect++;
    }

    feedbackExample.textContent = word.example;
    feedbackEl.classList.remove('hidden');
    document.getElementById('mc-next').classList.remove('hidden');
  }

  // -- Spelling Mode --
  function renderSpelling(word) {
    document.getElementById('sp-meaning').textContent = word.meaning;
    document.getElementById('sp-pos').textContent = word.pos;
    document.getElementById('sp-hint').textContent = '';
    document.getElementById('sp-feedback').classList.add('hidden');
    document.getElementById('sp-next').classList.add('hidden');
    document.getElementById('sp-check').classList.remove('hidden');
    document.getElementById('sp-hint-btn').classList.remove('hidden');

    const input = document.getElementById('sp-input');
    input.value = '';
    input.className = 'spelling-input';
    input.disabled = false;
    input.focus();

    document.querySelector('.spelling-actions').classList.remove('hidden');
  }

  function showSpellingHint(word) {
    const hint = word.word.split('').map((c, i) => {
      if (i === 0 || i === word.word.length - 1) return c;
      return Math.random() > 0.5 ? c : '_';
    }).join(' ');
    document.getElementById('sp-hint').textContent = hint;
    speak(word.word);
  }

  function checkSpelling(word) {
    const input = document.getElementById('sp-input');
    const answer = input.value.trim().toLowerCase();
    const correct = answer === word.word.toLowerCase();
    const feedbackEl = document.getElementById('sp-feedback');

    input.disabled = true;

    if (correct) {
      input.className = 'spelling-input correct';
      feedbackEl.textContent = '✓ Correct!';
      feedbackEl.style.background = 'var(--success-bg)';
      feedbackEl.style.color = '#166534';
      updateWordProgress(word.id, 3);
      sessionResults.correct++;
    } else {
      input.className = 'spelling-input wrong';
      feedbackEl.textContent = `✗ Correct spelling: ${word.word}`;
      feedbackEl.style.background = 'var(--danger-bg)';
      feedbackEl.style.color = '#991b1b';
      updateWordProgress(word.id, 0);
      sessionResults.incorrect++;
    }

    feedbackEl.classList.remove('hidden');
    document.querySelector('.spelling-actions').classList.add('hidden');
    document.getElementById('sp-next').classList.remove('hidden');
  }

  // -- Listening Mode --
  function renderListening(word) {
    document.getElementById('ls-feedback').classList.add('hidden');
    document.getElementById('ls-next').classList.add('hidden');

    const choices = generateChoices(word, 4, 'word');
    const container = document.getElementById('ls-choices');
    container.innerHTML = '';

    choices.forEach(choice => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = `${choice.word}  (${choice.meaning})`;
      btn.addEventListener('click', () => handleListeningAnswer(word, choice, btn));
      container.appendChild(btn);
    });

    setTimeout(() => speak(word.word), 300);
  }

  function handleListeningAnswer(word, choice, btn) {
    const correct = choice.id === word.id;
    const feedbackEl = document.getElementById('ls-feedback');
    const feedbackText = document.getElementById('ls-feedback-text');

    document.querySelectorAll('#ls-choices .choice-btn').forEach(b => {
      b.classList.add('disabled');
      if (b.textContent.startsWith(word.word)) b.classList.add('correct');
    });

    if (correct) {
      btn.classList.add('correct');
      feedbackText.textContent = `✓ Correct! ${word.word} - ${word.meaning}`;
      feedbackEl.style.background = 'var(--success-bg)';
      updateWordProgress(word.id, 2);
      sessionResults.correct++;
    } else {
      btn.classList.add('wrong');
      feedbackText.textContent = `✗ It was "${word.word}" - ${word.meaning}`;
      feedbackEl.style.background = 'var(--danger-bg)';
      updateWordProgress(word.id, 0);
      sessionResults.incorrect++;
    }

    feedbackEl.classList.remove('hidden');
    document.getElementById('ls-next').classList.remove('hidden');
  }

  // ===== HELPERS =====
  function generateChoices(targetWord, count, displayField) {
    const others = words.filter(w => w.id !== targetWord.id);
    shuffleArray(others);
    const distractors = others.slice(0, count - 1);
    const choices = [targetWord, ...distractors];
    shuffleArray(choices);
    return choices;
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ===== SESSION COMPLETE =====
  function showSessionComplete() {
    navigateTo('complete');
    document.getElementById('complete-total').textContent = sessionResults.total;
    document.getElementById('complete-correct').textContent = sessionResults.correct;
    const accuracy = sessionResults.total > 0
      ? Math.round((sessionResults.correct / sessionResults.total) * 100)
      : 0;
    document.getElementById('complete-accuracy').textContent = accuracy + '%';
    // Auto-upload progress to Google Sheet after every session
    uploadToSheet(true);
  }

  // ===== TEXT-TO-SPEECH =====
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = settings.speechSpeed || 0.9;

    const voices = window.speechSynthesis.getVoices();
    if (settings.voiceName) {
      const voice = voices.find(v => v.name === settings.voiceName);
      if (voice) utterance.voice = voice;
    } else {
      const enVoice = voices.find(v => v.lang.startsWith('en') && v.localService);
      if (enVoice) utterance.voice = enVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  function populateVoices() {
    const select = document.getElementById('setting-voice');
    if (!select) return;

    function fill() {
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
      select.innerHTML = '<option value="">Auto</option>';
      voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        if (v.name === settings.voiceName) opt.selected = true;
        select.appendChild(opt);
      });
    }

    fill();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = fill;
    }
  }

  // ===== WORD LIST =====
  function renderWordList(filter, search) {
    filter = filter || document.getElementById('wl-filter').value;
    search = search !== undefined ? search : (document.getElementById('wl-search').value || '');

    let filtered = [...words];

    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(w =>
        w.word.toLowerCase().includes(q) ||
        w.meaning.toLowerCase().includes(q)
      );
    }

    if (filter === 'new') filtered = filtered.filter(w => isNewWord(w.id));
    else if (filter === 'learning') filtered = filtered.filter(w => isLearning(w.id));
    else if (filter === 'mastered') filtered = filtered.filter(w => isMastered(w.id));
    else if (filter === 'due') filtered = filtered.filter(w => isDueForReview(w.id));

    const tbody = document.getElementById('wl-body');
    tbody.innerHTML = '';

    filtered.forEach(w => {
      const p = getWordProgress(w.id);
      const levelText = !p.lastReview ? 'New'
        : p.level >= CONFIG.MAX_LEVEL ? 'Mastered'
        : `Lv.${p.level}`;
      const levelClass = !p.lastReview ? 'new'
        : p.level >= CONFIG.MAX_LEVEL ? 'mastered'
        : 'learning';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${w.id}</td>
        <td class="word-cell">${w.word}</td>
        <td>${w.phonetic}</td>
        <td>${w.pos}</td>
        <td>${w.meaning}</td>
        <td><span class="level-badge ${levelClass}">${levelText}</span></td>
        <td>${p.nextReview || '-'}</td>
        <td><button class="wl-speak-btn" data-word="${w.word}">🔊</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  // ===== SETTINGS =====
  function renderSettings() {
    document.getElementById('setting-daily').value = settings.dailyNew;
    document.getElementById('setting-speed').value = settings.speechSpeed;
    document.getElementById('setting-speed-value').textContent = settings.speechSpeed + 'x';
    document.getElementById('setting-gas-url').value = settings.gasUrl || '';
    populateVoices();
  }

  // ===== GOOGLE SHEET SYNC =====

  // Merge two progress objects — for each word, keep the more advanced record
  function mergeProgressData(local, remote) {
    const merged = Object.assign({}, local);
    for (const [wordId, remoteData] of Object.entries(remote)) {
      if (!merged[wordId]) {
        merged[wordId] = remoteData;
      } else {
        const localData = merged[wordId];
        // Higher level wins; tie-break by more recent lastReview date
        if (remoteData.level > localData.level) {
          merged[wordId] = remoteData;
        } else if (remoteData.level === localData.level &&
                   remoteData.lastReview && localData.lastReview &&
                   remoteData.lastReview > localData.lastReview) {
          merged[wordId] = remoteData;
        }
      }
    }
    return merged;
  }

  // Download progress from Google Sheet and merge with localStorage
  async function syncFromSheet(silent) {
    if (!settings.gasUrl) return;
    try {
      const resp = await fetch(settings.gasUrl + '?action=getProgress');
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data || !data.progress) return;

      // Separate _studyDays from word progress
      const localStudyDays = progress._studyDays || [];
      const localWordProgress = Object.assign({}, progress);
      delete localWordProgress._studyDays;

      const merged = mergeProgressData(localWordProgress, data.progress);

      // Merge study days (union, deduplicated)
      const allDays = Array.from(new Set([
        ...localStudyDays,
        ...(data.studyDays || [])
      ])).sort();

      progress = Object.assign(merged, { _studyDays: allDays });
      saveProgress();

      if (!silent) showToast('✅ Progress loaded from Google Sheet!');
    } catch (e) {
      console.error('Load from sheet error:', e);
      if (!silent) showToast('Could not load from Google Sheet');
    }
  }

  // Upload progress to Google Sheet
  async function uploadToSheet(silent) {
    if (!settings.gasUrl) return false;
    try {
      const progressData = {};
      Object.entries(progress).forEach(([key, val]) => {
        if (key !== '_studyDays') progressData[key] = val;
      });

      await fetch(settings.gasUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'saveProgress',
          user: CONFIG.VALID_USER,
          progress: progressData,
          studyDays: progress._studyDays || []
        })
      });

      if (!silent) showToast('✅ Progress synced to Google Sheet!');
      return true;
    } catch (e) {
      console.error('Upload to sheet error:', e);
      if (!silent) showToast('Sync failed. Check the URL in Settings.');
      return false;
    }
  }

  // Manual sync button: full two-way sync (upload then download)
  async function syncWithSheet() {
    if (!settings.gasUrl) {
      showToast('Set the Apps Script URL in Settings first');
      return;
    }

    const syncBtn = document.getElementById('sync-btn');
    syncBtn.disabled = true;
    syncBtn.style.animation = 'spin 1s linear infinite';

    try {
      await uploadToSheet(true);
      // Give Apps Script a moment to finish writing before reading back
      await new Promise(r => setTimeout(r, 1500));
      await syncFromSheet(true);
      showToast('✅ Two-way sync complete!');
    } catch (e) {
      console.error('Sync error:', e);
      showToast('Sync failed. Check the URL in Settings.');
    } finally {
      syncBtn.disabled = false;
      syncBtn.style.animation = '';
    }
  }

  async function testSyncConnection() {
    const url = document.getElementById('setting-gas-url').value.trim();
    const statusEl = document.getElementById('sync-status');

    if (!url) {
      statusEl.textContent = 'Enter a URL first';
      statusEl.style.color = 'var(--danger)';
      return;
    }

    statusEl.textContent = 'Testing...';
    statusEl.style.color = 'var(--text-secondary)';

    try {
      await fetch(url + '?action=ping', { mode: 'no-cors' });
      statusEl.textContent = 'Request sent (no-cors)';
      statusEl.style.color = 'var(--success)';
      settings.gasUrl = url;
      saveSettings();
    } catch (e) {
      statusEl.textContent = 'Connection failed';
      statusEl.style.color = 'var(--danger)';
    }
  }

  // ===== EXPORT / IMPORT =====
  function exportProgress() {
    const data = {
      progress,
      settings: { dailyNew: settings.dailyNew },
      exportDate: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocabmaster_progress_${getTodayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Progress exported!');
  }

  function importProgress(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.progress) {
          progress = data.progress;
          saveProgress();
          showToast('Progress imported successfully!');
          renderDashboard();
        }
      } catch {
        showToast('Invalid file format');
      }
    };
    reader.readAsText(file);
  }

  // ===== TOAST =====
  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.add('hidden'), 3000);
  }

  // ===== EVENT LISTENERS =====
  function setupEventListeners() {
    // Login
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('toggle-password').addEventListener('click', () => {
      const pw = document.getElementById('password');
      pw.type = pw.type === 'password' ? 'text' : 'password';
    });

    // Navigation
    document.getElementById('nav-home-btn').addEventListener('click', () => navigateTo('dashboard'));
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('settings-btn').addEventListener('click', () => navigateTo('settings'));
    document.getElementById('sync-btn').addEventListener('click', syncWithSheet);

    document.querySelectorAll('.bottom-nav-item[data-page]').forEach(btn => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.page));
    });

    // Quick Start
    document.getElementById('quick-start').addEventListener('click', () => {
      document.getElementById('mode-modal').classList.remove('hidden');
    });

    // Mode selection
    document.querySelectorAll('.mode-card').forEach(card => {
      card.addEventListener('click', () => startPractice(card.dataset.mode));
    });

    document.querySelectorAll('.modal-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('mode-modal').classList.add('hidden');
        startPractice(btn.dataset.mode);
      });
    });

    document.getElementById('modal-cancel').addEventListener('click', () => {
      document.getElementById('mode-modal').classList.add('hidden');
    });

    // Flashcard - attach to container, front, and back for reliable touch/click
    document.getElementById('flashcard').addEventListener('click', flipCard);
    document.querySelector('.flashcard-front').addEventListener('click', flipCard);
    document.querySelector('.flashcard-back').addEventListener('click', flipCard);
    document.getElementById('fc-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      speak(sessionWords[currentWordIndex]?.word);
    });
    document.getElementById('fc-speak-back').addEventListener('click', (e) => {
      e.stopPropagation();
      speak(sessionWords[currentWordIndex]?.word);
    });
    document.getElementById('fc-forgot').addEventListener('click', () => rateFlashcard(0));
    document.getElementById('fc-hard').addEventListener('click', () => rateFlashcard(1));
    document.getElementById('fc-good').addEventListener('click', () => rateFlashcard(2));
    document.getElementById('fc-easy').addEventListener('click', () => rateFlashcard(3));

    // Multiple Choice
    document.getElementById('mc-speak').addEventListener('click', () => {
      speak(sessionWords[currentWordIndex]?.word);
    });
    document.getElementById('mc-next').addEventListener('click', nextWord);

    // Spelling
    document.getElementById('sp-speak').addEventListener('click', () => {
      speak(sessionWords[currentWordIndex]?.word);
    });
    document.getElementById('sp-hint-btn').addEventListener('click', () => {
      showSpellingHint(sessionWords[currentWordIndex]);
    });
    document.getElementById('sp-check').addEventListener('click', () => {
      checkSpelling(sessionWords[currentWordIndex]);
    });
    document.getElementById('sp-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!document.getElementById('sp-input').disabled) {
          checkSpelling(sessionWords[currentWordIndex]);
        } else {
          nextWord();
        }
      }
    });
    document.getElementById('sp-next').addEventListener('click', nextWord);

    // Listening
    document.getElementById('ls-speak').addEventListener('click', () => {
      speak(sessionWords[currentWordIndex]?.word);
    });
    document.getElementById('ls-next').addEventListener('click', nextWord);

    // Practice navigation
    document.getElementById('practice-back').addEventListener('click', () => {
      navigateTo('dashboard');
    });

    // Session complete
    document.getElementById('complete-home').addEventListener('click', () => navigateTo('dashboard'));
    document.getElementById('complete-continue').addEventListener('click', () => {
      document.getElementById('mode-modal').classList.remove('hidden');
    });

    // Word list
    document.getElementById('wl-filter').addEventListener('change', () => renderWordList());
    document.getElementById('wl-search').addEventListener('input', () => renderWordList());
    document.getElementById('wl-body').addEventListener('click', (e) => {
      if (e.target.classList.contains('wl-speak-btn')) {
        speak(e.target.dataset.word);
      }
    });

    // Settings
    document.getElementById('setting-daily').addEventListener('change', (e) => {
      settings.dailyNew = parseInt(e.target.value) || CONFIG.DAILY_NEW_WORDS;
      saveSettings();
      showToast('Daily goal updated');
    });

    document.getElementById('setting-voice').addEventListener('change', (e) => {
      settings.voiceName = e.target.value;
      saveSettings();
      speak('Hello, this is a test');
    });

    document.getElementById('setting-speed').addEventListener('input', (e) => {
      settings.speechSpeed = parseFloat(e.target.value);
      document.getElementById('setting-speed-value').textContent = settings.speechSpeed + 'x';
      saveSettings();
    });

    document.getElementById('setting-gas-url').addEventListener('change', (e) => {
      settings.gasUrl = e.target.value.trim();
      saveSettings();
    });

    document.getElementById('btn-test-sync').addEventListener('click', testSyncConnection);

    document.getElementById('btn-change-password').addEventListener('click', async () => {
      const newPw = document.getElementById('setting-new-password').value;
      if (!newPw) { showToast('Enter a new password'); return; }
      settings.passwordHash = await hashPassword(newPw);
      saveSettings();
      document.getElementById('setting-new-password').value = '';
      showToast('Password updated');
    });

    document.getElementById('btn-export').addEventListener('click', exportProgress);
    document.getElementById('btn-import').addEventListener('click', () => {
      document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importProgress(e.target.files[0]);
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all progress? This cannot be undone.')) {
        progress = {};
        saveProgress();
        showToast('Progress reset');
        renderDashboard();
      }
    });

    // Keyboard shortcuts during practice
    document.addEventListener('keydown', (e) => {
      if (currentMode !== 'flashcard') return;
      const card = document.getElementById('flashcard');

      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        flipCard();
      } else if (card.classList.contains('flipped')) {
        if (e.key === '1') rateFlashcard(0);
        else if (e.key === '2') rateFlashcard(1);
        else if (e.key === '3') rateFlashcard(2);
        else if (e.key === '4') rateFlashcard(3);
      }
    });
  }

  // ===== START =====
  document.addEventListener('DOMContentLoaded', init);
})();
