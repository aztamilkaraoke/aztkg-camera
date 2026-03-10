(function(){
  const APPS_SCRIPT_BASE = 'https://script.google.com/macros/s/AKfycbxKyrSPRTaQ_QWV2csWPfywQUirH7iizglA4TMpSkAAfP4GaT0x3Pi26NK6nF7kCHSyeg/exec';
  const FAST_POLL_MS = 1500;
  const IDLE_POLL_MS = 5000;
  const MAX_CLIP_MS = 12 * 60 * 1000;

  let stream = null;
  let recorder = null;
  let chunks = [];
  let chosenMime = '';
  let chosenExt = 'webm';
  let activePerf = null;
  let activePerfStartedAtIso = '';
  let lastProcessedCommandSeq = 0;
  let recordingStartedAtMs = 0;
  let inFlight = false;
  let wakeLock = null;
  let jsonpCounter = 0;
  let lastMode = 'SPLASH';
  let pollTimer = null;
  let pollFailCount = 0;
  let currentPollMs = 0;

  const els = {
    camReady: document.getElementById('camReady'),
    netState: document.getElementById('netState'),
    recState: document.getElementById('recState'),
    quality: document.getElementById('quality'),
    seqNo: document.getElementById('seqNo'),
    songName: document.getElementById('songName'),
    singers: document.getElementById('singers'),
    meta: document.getElementById('meta'),
    statusPill: document.getElementById('statusPill'),
    elapsed: document.getElementById('elapsed'),
    recentText: document.getElementById('recentText'),
    preview: document.getElementById('preview'),
    debugLine: document.getElementById('debugLine'),
    btnEmergencyStop: document.getElementById('btnEmergencyStop'),
    btnRefreshState: document.getElementById('btnRefreshState')
  };

  function setTop(el, text) {
    if (el) el.textContent = text;
  }

  function setDebug(text, isWarn) {
    if (!els.debugLine) return;
    els.debugLine.textContent = text || '';
    els.debugLine.className = 'debugLine' + (isWarn ? ' warnLine' : '');
  }

  function setIdleDebug() {
    if (lastMode === 'ENDED') {
      setDebug('Meet ended — thanks for singing!', false);
    } else if (lastMode === 'SPLASH') {
      setDebug('Waiting for host to start the meet…', false);
    } else {
      setDebug('Meet is live — waiting for next song…', false);
    }
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function chooseMime() {
    const prefs = [
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];

    for (const m of prefs) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
          chosenMime = m;
          chosenExt = m.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
          return;
        }
      } catch (e) {}
    }

    chosenMime = '';
    chosenExt = 'webm';
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {}
  }

  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  function jsonp(url) {
    return new Promise(function(resolve, reject) {
      const cbName = '__camJsonpCb_' + (++jsonpCounter);
      const script = document.createElement('script');
      const sep = url.indexOf('?') >= 0 ? '&' : '?';
      const fullUrl = url + sep + 'callback=' + cbName + '&_ts=' + Date.now();

      let done = false;
      const cleanup = function() {
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      };

      window[cbName] = function(data) {
        if (done) return;
        done = true;
        cleanup();
        resolve(data);
      };

      script.onerror = function() {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('JSONP load failed'));
      };

      script.src = fullUrl;
      document.body.appendChild(script);

          setTimeout(function() {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('JSONP timeout'));
      }, 20000);
    });
  }

  function beaconGet(params) {
    const url = APPS_SCRIPT_BASE + '?' + new URLSearchParams(params).toString();
    const img = new Image();
    img.src = url;
  }

  function buildMetaLines(perf) {
    const lines = [];
    if (perf.songType) lines.push(perf.songType);
    if (perf.meetName) lines.push(perf.meetName);
    if (perf.movieName) lines.push(perf.movieName);
    if (perf.composerName) lines.push(perf.composerName);
    return lines;
  }

  function setRecordingUiCompact(isRecording) {
    const songSize = isRecording ? '24px' : '31px';
    const singerSize = isRecording ? '16px' : '20px';
    const metaSize = isRecording ? '12px' : '14px';
    const statusPad = isRecording ? '8px 12px' : '10px 16px';

    if (els.songName) els.songName.style.fontSize = songSize;
    if (els.singers) els.singers.style.fontSize = singerSize;
    if (els.meta) els.meta.style.fontSize = metaSize;
    if (els.statusPill) els.statusPill.style.padding = statusPad;
  }

  function updateStopButton(isRecording) {
    if (!els.btnEmergencyStop) return;
    els.btnEmergencyStop.disabled = !isRecording;
    els.btnEmergencyStop.textContent = isRecording ? 'STOP RECORDING' : 'NO ACTIVE RECORDING';
    els.btnEmergencyStop.style.opacity = isRecording ? '1' : '0.55';
    els.btnEmergencyStop.style.cursor = isRecording ? 'pointer' : 'not-allowed';
  }

  function applyFocus(perf, mode) {
    const isRecording = mode === 'recording';

    if (!perf) {
      els.seqNo.textContent = '';

      if (lastMode === 'ENDED') {
        els.songName.textContent = 'Meet ended — thanks for singing!';
        els.statusPill.textContent = 'MEET ENDED';
      } else if (lastMode === 'SPLASH') {
        els.songName.textContent = 'Waiting for host to start the meet…';
        els.statusPill.textContent = 'NOT STARTED';
      } else {
        els.songName.textContent = 'Meet is live — waiting for next song…';
        els.statusPill.textContent = 'WAITING';
      }

      els.singers.textContent = '';
      els.meta.innerHTML = '<div>—</div>';
      els.statusPill.className = 'statusPill';
      els.elapsed.textContent = '';
      setRecordingUiCompact(false);
      updateStopButton(false);
      return;
    }

    // Keep seq on screen if you want visual reference, but not in filename
    els.seqNo.textContent = perf.seqNo ? ('SEQ #' + perf.seqNo) : '';
    els.songName.textContent = perf.songName || '—';
    els.singers.textContent = (perf.singers || []).join(' & ') || '—';

    const metaLines = buildMetaLines(perf);
    els.meta.innerHTML = metaLines.length
      ? metaLines.map(x => '<div>' + escapeHtml(x) + '</div>').join('')
      : '<div>—</div>';

    if (mode === 'recording') {
      els.statusPill.textContent = 'RECORDING IN PROGRESS';
      els.statusPill.className = 'statusPill recording';
    } else if (mode === 'saving') {
      els.statusPill.textContent = 'SAVING';
      els.statusPill.className = 'statusPill saving';
    } else {
      els.statusPill.textContent = 'NOT STARTED';
      els.statusPill.className = 'statusPill';
      els.elapsed.textContent = '';
    }

    setRecordingUiCompact(isRecording);
    updateStopButton(isRecording);
  }

  function applyState(st) {
    const display = st && st.performanceDisplay ? st.performanceDisplay : {};
    const cameraStatus = st && st.cameraStatus ? st.cameraStatus : {};
    const current = display.current || null;
    const upcoming = display.upcoming || null;
    const lastRecorded = display.lastRecorded || null;
    const mode = (st && st.mode) ? st.mode : 'SPLASH';
    const isActive = !!current || mode === 'LIVE';
    restartPollLoop(isActive);

    lastMode = mode;

    setTop(els.recState, 'Recorder: ' + (cameraStatus.recorderState || '—'));

    if (mode === 'SPLASH') {
      applyFocus(null, 'idle');
      setIdleDebug();
    } else if (mode === 'ENDED') {
      applyFocus(null, 'idle');
      setIdleDebug();
    } else {
      const focusMode = current
        ? (current.status === 'saving' ? 'saving' : 'recording')
        : 'idle';

      applyFocus(current || upcoming, focusMode);

      if (current) {
        if (current.status === 'saving') {
          setDebug('Saving clip…', false);
        } else {
          setDebug('Recording in progress…', false);
        }
      } else if (upcoming) {
        setDebug('Meet is live — next song is loaded.', false);
      } else {
        setIdleDebug();
      }
    }
    if (lastRecorded) {
      const seq = lastRecorded.seqNo ? ('SEQ #' + lastRecorded.seqNo) : '';
      els.recentText.textContent = (seq ? seq + ' - ' : '') + (lastRecorded.songName || '—');
    } else {
      els.recentText.textContent = '—';
    }
  }

  function buildFilename(perf) {
    const singerPart = (perf.singers || []).join(' & ');

    const base = [
      perf.songName,
      singerPart,
      perf.songType,
      perf.meetName,
      perf.movieName,
      perf.composerName
    ]
      .filter(Boolean)
      .join(' - ')
      .replace(/[\/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/g, '')
      .trim();

    return base + '.' + chosenExt;
  }

  async function writeBlobToPickedDirectory(blob, filename) {
    if (!window.showDirectoryPicker) return false;

    try {
      let dirHandle = window.__aztkgDirHandle || null;

      if (!dirHandle) {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        window.__aztkgDirHandle = dirHandle;
      }

      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      return false;
    }
  }

  function triggerDownload(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(function(){
      URL.revokeObjectURL(url);
      a.remove();
    }, 2000);
  }

    function validateAudioTrackOrThrow(s) {
    const tracks = s ? s.getAudioTracks() : [];
    if (!tracks.length) {
      throw new Error('No audio track available from microphone');
    }

    const liveTrack = tracks.find(function(t) {
      return t && t.enabled !== false && t.readyState === 'live';
    });

    if (!liveTrack) {
      throw new Error('Microphone track is not live');
    }

    return liveTrack;
  }

  async function initMedia() {
    chooseMime();

    if (!window.isSecureContext) {
      throw new Error('Not running in secure context');
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia is not available in this browser/context');
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
    } catch (e1) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
    }

    validateAudioTrackOrThrow(stream);

    els.preview.srcObject = stream;
    console.log('Audio tracks:', stream.getAudioTracks().length);
    const vt = stream.getVideoTracks()[0];
    const s = vt && vt.getSettings ? vt.getSettings() : {};
    console.log('Video settings:', s);
    setTop(els.camReady, 'Camera: Ready');
    setTop(
      els.quality,
      'Quality: ' +
      (s.width || '—') + 'x' + (s.height || '—') +
      (s.frameRate ? (' @ ' + s.frameRate + 'fps') : '')
    );

    setDebug('Camera initialized. Syncing meet state…', false);

    beaconGet({
      api: 'camera-status',
      pageOpen: '1',
      cameraReady: '1',
      streamReady: '1',
      recorderState: 'idle',
      actualMimeType: chosenMime,
      actualWidth: s.width || 0,
      actualHeight: s.height || 0,
      actualFps: s.frameRate || 0,
      lastError: '',
      _ts: Date.now()
    });

    updateStopButton(false);
    await requestWakeLock();
  }

  function updateHeartbeat(extra) {
    const params = Object.assign({
      api: 'camera-status',
      pageOpen: '1',
      _ts: Date.now()
    }, extra || {});
    beaconGet(params);
  }

  function startRecording(perf, commandSeq) {
    if (!stream) return;
    if (recorder && recorder.state === 'recording') {
      lastProcessedCommandSeq = commandSeq;
      return;
    }

    chunks = [];
    activePerf = perf;
    activePerfStartedAtIso = perf && perf.startedAt ? perf.startedAt : '';
    recordingStartedAtMs = activePerfStartedAtIso
      ? new Date(activePerfStartedAtIso).getTime()
      : Date.now();

    const options = chosenMime ? {
      mimeType: chosenMime,
      videoBitsPerSecond: 8000000,
      audioBitsPerSecond: 128000
    } : undefined;

    recorder = new MediaRecorder(stream, options);

    recorder.ondataavailable = function(e) {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onerror = function(e) {
      setDebug('Recorder error', true);
      updateHeartbeat({
        recorderState: 'error',
        lastError: String((e && e.error && e.error.message) || 'Recorder error')
      });
    };

    recorder.onstop = async function() {
      try {
        const blob = new Blob(chunks, { type: chosenMime || 'video/webm' });
        const filename = buildFilename(activePerf);

        setDebug('Saving clip…', false);

        const wroteDirect = await writeBlobToPickedDirectory(blob, filename);
        if (!wroteDirect) {
          triggerDownload(blob, filename);
        }

        beaconGet({
          api: 'camera-clip-saved',
          performanceId: activePerf ? activePerf.performanceId : '',
          seqNo: activePerf ? activePerf.seqNo : '',
          songName: activePerf ? activePerf.songName : '',
          savedFileName: filename,
          _ts: Date.now()
        });

        updateHeartbeat({
          recorderState: 'idle',
          currentPerformanceId: '',
          lastSavedFilename: filename,
          lastError: ''
        });

          } catch (err) {
        const msg = String(err && err.message || err || 'Clip save failed');

        setDebug('Clip save failed — fallback download may be needed.', true);

        updateHeartbeat({
          recorderState: 'error',
          currentPerformanceId: '',
          lastError: msg
        });
      } finally {
        activePerf = null;
        activePerfStartedAtIso = '';
        chunks = [];
        recordingStartedAtMs = 0;
        els.elapsed.textContent = '';
        updateStopButton(false);
        recorder = null;
        setIdleDebug();
      }
    };

    recorder.start(2000);
    lastProcessedCommandSeq = commandSeq;

    updateHeartbeat({
      recorderState: 'recording',
      currentCommandSeq: commandSeq,
      currentPerformanceId: perf.performanceId || '',
      recordingStartedAt: perf.startedAt || new Date().toISOString(),
      lastError: ''
    });

    setDebug('Recording in progress...', false);
    updateStopButton(true);
  }

  function stopRecording(commandSeq) {
    if (!recorder || recorder.state !== 'recording') {
      lastProcessedCommandSeq = commandSeq;
      updateStopButton(false);
      return;
    }

    lastProcessedCommandSeq = commandSeq;

    updateHeartbeat({
      recorderState: 'saving',
      currentCommandSeq: commandSeq
    });

    setDebug('Stopping recorder...', false);
    recorder.stop();
    updateStopButton(false);
  }

  function tick() {
    if (recorder && recorder.state === 'recording' && recordingStartedAtMs) {
      const ms = Date.now() - recordingStartedAtMs;
      const totalSec = Math.floor(Math.max(0, ms) / 1000);
      const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
      const ss = String(totalSec % 60).padStart(2, '0');
      els.elapsed.textContent = mm + ':' + ss;

      if (ms > MAX_CLIP_MS) {
        stopRecording(lastProcessedCommandSeq);
      }
    }
  }

  function handleCommand(st) {
    const rc = st && st.recordingControl ? st.recordingControl : {};
    if (!rc.commandSeq) return;
    if (Number(rc.commandSeq) <= Number(lastProcessedCommandSeq || 0)) return;

    if (rc.desiredState === 'recording' && rc.startContext) {
      startRecording(rc.startContext, rc.commandSeq);
      return;
    }

    if (rc.desiredState === 'idle') {
      stopRecording(rc.commandSeq);
    }
  }

  function restartPollLoop(isActive) {
    const nextMs = isActive ? FAST_POLL_MS : IDLE_POLL_MS;
    if (pollTimer && currentPollMs === nextMs) return;

    if (pollTimer) clearInterval(pollTimer);
    currentPollMs = nextMs;
    pollTimer = setInterval(poll, nextMs);
  }

  async function poll() {
    if (inFlight) return;
    inFlight = true;
    setTop(els.netState, 'Network: Syncing');

    try {
            const st = await jsonp(APPS_SCRIPT_BASE + '?api=camera-state');
      pollFailCount = 0;
      setTop(els.netState, 'Network: Online');
      applyState(st);
      handleCommand(st);
      updateHeartbeat();
    } catch (err) {
      setTop(els.netState, 'Network: Offline');
      setDebug('Polling failed. Recording continues if already active.', true);
      updateHeartbeat({
        lastError: String(err && err.message || err || 'Polling failed')
      });
    } finally {
      inFlight = false;
    }
  }

  els.btnEmergencyStop.addEventListener('click', function(){
    if (!(recorder && recorder.state === 'recording')) return;

    setDebug('Manual stop requested…', false);
    stopRecording(Number(lastProcessedCommandSeq || 0));
  });

  els.btnRefreshState.addEventListener('click', function(){
    poll();
  });

  initMedia()
    .then(function(){
      poll();
      restartPollLoop(false);
      setInterval(tick, 1000);
    })
    .catch(function(err){
      const msg = String(
        err && err.name
          ? (err.name + ': ' + (err.message || ''))
          : (err && err.message || err || 'Camera initialization failed')
      );

      setTop(els.camReady, 'Camera: Error');
      setDebug(msg, true);

      updateHeartbeat({
        pageOpen: '1',
        cameraReady: '0',
        streamReady: '0',
        recorderState: 'error',
        lastError: msg
      });

      alert('Camera initialization failed.\n\n' + msg);
    });
})();
