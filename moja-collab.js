/*
  MOJA XR v15 — współpraca VR/MR przez Supabase Realtime.

  Funkcje:
  - Presence: lista osób w pokoju.
  - Głowa, dłonie i laser drugiej osoby.
  - Wspólne zaznaczenia komponentów.
  - Wspólne Hide / Show / Isolate / Show All / Edges.
  - Wspólne pomiary.
  - Wspólne rysowanie i tekst 3D.
  - Synchronizacja położenia modelu przez prowadzącego.

  Kod jest opcjonalny. Gdy moja-config.js ma enabled:false albo w adresie
  nie ma parametru ?room=..., quest.html działa całkowicie lokalnie.
*/
(function () {
  'use strict';

  var CONFIG = window.MOJA_XR_CONFIG || {};
  var COLLAB = CONFIG.collaboration || {};
  var PARAMS = new URLSearchParams(window.location.search);
  var MODEL = String(window.MOJA_XR_MODEL || document.title || 'model').trim();
  var ROOM = sanitizeRoom(PARAMS.get('room') || COLLAB.defaultRoom || '');
  var USER_NAME = sanitizeName(PARAMS.get('name') || safeStorageGet('moja-xr-user-name') || 'Użytkownik');
  var ROLE = String(PARAMS.get('role') || '').toLowerCase() === 'host' ? 'host' : 'guest';
  var FOLLOW = PARAMS.get('follow') !== '0';
  var CLIENT_ID = createClientId();
  var COLOR = colorFor(CLIENT_ID);
  var POSE_HZ = clamp(Number(COLLAB.poseHz) || 10, 2, 15);
  var TOPIC = 'moja-xr-v15-' + compact(MODEL).slice(0, 32) + '-' + compact(ROOM).slice(0, 64);

  var scene = null;
  var channel = null;
  var supabaseClient = null;
  var subscribed = false;
  var suppress = false;
  var patchReady = false;
  var poseTimer = null;
  var transformTimer = null;
  var lastStateRequestAt = 0;
  var remoteAvatars = new Map();
  var remoteStrokes = new Map();
  var onlineUsers = new Map();
  var ui = {};

  var url = String(COLLAB.supabaseUrl || '').trim();
  var key = String(COLLAB.supabasePublishableKey || '').trim();
  var configured = Boolean(
    COLLAB.enabled &&
    ROOM &&
    /^https:\/\//i.test(url) &&
    key.length > 20 &&
    key.indexOf('WKLEJ_') < 0 &&
    url.indexOf('TWOJ-PROJEKT') < 0
  );

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    scene = document.getElementById('scene');
    injectUi();
    safeStorageSet('moja-xr-user-name', USER_NAME);

    if (!ROOM) {
      updateStatus('TRYB LOKALNY', 'offline');
      updateOnlineUi();
      return;
    }

    if (!configured) {
      updateStatus('ROOM ' + ROOM.slice(0, 8) + ' • BRAK KONFIGURACJI', 'error');
      setUiNote('Uzupełnij moja-config.js danymi Supabase. Viewer nadal działa lokalnie.');
      return;
    }

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      updateStatus('SUPABASE NIE WCZYTANY', 'error');
      setUiNote('Nie udało się pobrać biblioteki Supabase. Sprawdź połączenie z Internetem.');
      return;
    }

    waitForScene(function () {
      connect();
      patchComponentsWhenReady();
    });
  }

  function injectUi() {
    var style = document.createElement('style');
    style.textContent = [
      '.collab-pill{border-color:rgba(167,139,250,.45)!important;color:#e9d5ff!important}',
      '.collab-pill.ok{border-color:rgba(34,197,94,.55)!important;color:#86efac!important}',
      '.collab-pill.error{border-color:rgba(239,68,68,.55)!important;color:#fca5a5!important}',
      '.collab-card{margin:14px auto 4px;width:min(100%,590px);padding:12px 14px;border:1px solid rgba(148,163,184,.24);border-radius:16px;background:rgba(15,23,42,.56);text-align:left}',
      '.collab-line{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#e2e8f0;font-size:12px;font-weight:800}',
      '.collab-line small{color:#94a3b8;font-size:10px;font-weight:700}',
      '.collab-users{margin-top:7px;color:#c4b5fd;font-size:11px;line-height:1.45}',
      '.collab-follow{display:flex;align-items:center;gap:7px;margin-top:9px;color:#cbd5e1;font-size:11px}',
      '.collab-follow input{accent-color:#7c3aed}',
      '@media(max-width:720px){.collab-pill span{display:none}.collab-card{padding:10px}.collab-line{font-size:11px}}'
    ].join('');
    document.head.appendChild(style);

    var topbar = document.querySelector('.topbar');
    if (topbar) {
      ui.pill = document.createElement('div');
      ui.pill.className = 'pill collab-pill';
      ui.pill.innerHTML = '<span>ROOM</span>';
      var enter = document.getElementById('enterXR');
      topbar.insertBefore(ui.pill, enter || null);
    }

    var card = document.querySelector('#landing .card');
    if (card) {
      ui.card = document.createElement('div');
      ui.card.className = 'collab-card';
      ui.card.innerHTML =
        '<div class="collab-line"><span id="collabRole"></span><small id="collabState"></small></div>' +
        '<div id="collabUsers" class="collab-users"></div>' +
        (ROLE === 'guest' ? '<label class="collab-follow"><input id="collabFollow" type="checkbox"> Podążaj za położeniem modelu prowadzącego</label>' : '') +
        '<div id="collabNote" class="collab-users"></div>';
      var controls = document.getElementById('landingControls');
      card.insertBefore(ui.card, controls || null);
      ui.role = document.getElementById('collabRole');
      ui.state = document.getElementById('collabState');
      ui.users = document.getElementById('collabUsers');
      ui.note = document.getElementById('collabNote');
      ui.role.textContent = (ROLE === 'host' ? 'PROWADZĄCY' : 'UCZESTNIK') + ' • ' + USER_NAME + ' • ROOM ' + ROOM;
      if (ROLE === 'guest') {
        ui.follow = document.getElementById('collabFollow');
        ui.follow.checked = FOLLOW;
        ui.follow.addEventListener('change', function () { FOLLOW = Boolean(ui.follow.checked); });
      }
    }
  }

  function updateStatus(text, kind) {
    if (ui.pill) {
      ui.pill.classList.remove('ok', 'error');
      if (kind === 'ok') ui.pill.classList.add('ok');
      if (kind === 'error') ui.pill.classList.add('error');
      ui.pill.innerHTML = '<span>' + escapeHtml(text) + '</span>';
    }
    if (ui.state) ui.state.textContent = text;
  }

  function setUiNote(text) {
    if (ui.note) ui.note.textContent = text || '';
  }

  function updateOnlineUi() {
    var names = [];
    onlineUsers.forEach(function (user) {
      names.push(user.name + (user.role === 'host' ? ' [prowadzący]' : ''));
    });
    if (ui.users) ui.users.textContent = names.length ? 'Online: ' + names.join(' • ') : 'Online: tylko Ty / oczekiwanie na drugą osobę';
  }

  function waitForScene(callback) {
    if (!scene) return;
    if (scene.hasLoaded) { callback(); return; }
    scene.addEventListener('loaded', callback, { once: true });
  }

  function connect() {
    try {
      supabaseClient = window.supabase.createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });

      channel = supabaseClient.channel(TOPIC, {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: CLIENT_ID },
          private: COLLAB.publicChannels === false
        }
      });

      listenBroadcast('pose', onRemotePose);
      listenBroadcast('action', onRemoteAction);
      listenBroadcast('selection', onRemoteSelection);
      listenBroadcast('selection-clear', onRemoteSelectionClear);
      listenBroadcast('scale', onRemoteScale);
      listenBroadcast('measurement-point', onRemoteMeasurementPoint);
      listenBroadcast('measurement-clear', onRemoteMeasurementClear);
      listenBroadcast('annotation-stroke-start', onRemoteStrokeStart);
      listenBroadcast('annotation-stroke-segment', onRemoteStrokeSegment);
      listenBroadcast('annotation-stroke-end', onRemoteStrokeEnd);
      listenBroadcast('annotation-text', onRemoteText);
      listenBroadcast('model-transform', onRemoteModelTransform);
      listenBroadcast('state-request', onStateRequest);
      listenBroadcast('state-snapshot', onStateSnapshot);

      channel.on('presence', { event: 'sync' }, syncPresence);
      channel.on('presence', { event: 'join' }, syncPresence);
      channel.on('presence', { event: 'leave' }, syncPresence);

      updateStatus('ŁĄCZENIE • ' + ROOM.slice(0, 8), 'offline');

      channel.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          subscribed = true;
          updateStatus('ONLINE • ' + ROOM.slice(0, 8), 'ok');
          channel.track({
            id: CLIENT_ID,
            name: USER_NAME,
            role: ROLE,
            mode: String(window.QUEST_MODE || 'vr'),
            color: COLOR,
            online_at: new Date().toISOString()
          });
          startIntervals();
          if (ROLE !== 'host') requestState();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          subscribed = false;
          updateStatus('BŁĄD POŁĄCZENIA', 'error');
        }
      });
    } catch (error) {
      console.error('[MOJA XR Collab] connect', error);
      updateStatus('BŁĄD SUPABASE', 'error');
    }
  }

  function listenBroadcast(eventName, handler) {
    channel.on('broadcast', { event: eventName }, function (message) {
      var payload = message && message.payload ? message.payload : {};
      if (payload.sender === CLIENT_ID) return;
      handler(payload);
    });
  }

  function send(eventName, payload) {
    if (!subscribed || !channel) return;
    var body = Object.assign({
      sender: CLIENT_ID,
      senderName: USER_NAME,
      senderRole: ROLE,
      senderMode: String(window.QUEST_MODE || 'vr'),
      ts: Date.now()
    }, payload || {});
    channel.send({ type: 'broadcast', event: eventName, payload: body });
  }

  function syncPresence() {
    if (!channel) return;
    var presence = channel.presenceState() || {};
    var current = new Map();

    Object.keys(presence).forEach(function (presenceKey) {
      var entries = Array.isArray(presence[presenceKey]) ? presence[presenceKey] : [];
      entries.forEach(function (entry) {
        if (!entry || entry.id === CLIENT_ID) return;
        current.set(entry.id, {
          id: entry.id,
          name: sanitizeName(entry.name || 'Użytkownik'),
          role: entry.role === 'host' ? 'host' : 'guest',
          color: entry.color || colorFor(entry.id),
          mode: entry.mode || 'vr'
        });
      });
    });

    onlineUsers = current;
    updateOnlineUi();

    Array.from(remoteAvatars.keys()).forEach(function (id) {
      if (!current.has(id)) removeAvatar(id);
    });

    if (ROLE !== 'host') {
      var hostExists = false;
      current.forEach(function (user) { if (user.role === 'host') hostExists = true; });
      if (hostExists && Date.now() - lastStateRequestAt > 3000) requestState();
    }
  }

  function startIntervals() {
    stopIntervals();
    poseTimer = window.setInterval(sendLocalPose, Math.round(1000 / POSE_HZ));
    transformTimer = window.setInterval(function () {
      if (ROLE === 'host') sendModelTransform();
    }, 250);
  }

  function stopIntervals() {
    if (poseTimer) window.clearInterval(poseTimer);
    if (transformTimer) window.clearInterval(transformTimer);
    poseTimer = null;
    transformTimer = null;
  }

  function isImmersive() {
    return Boolean(scene && scene.is && (scene.is('vr-mode') || scene.is('ar-mode')));
  }

  function worldPose(element) {
    if (!element || !element.object3D) return null;
    var position = new THREE.Vector3();
    var quaternion = new THREE.Quaternion();
    element.object3D.getWorldPosition(position);
    element.object3D.getWorldQuaternion(quaternion);
    return { p: vec3Array(position), q: quatArray(quaternion) };
  }

  function resolveActiveRay(left, right) {
    var presentationRay = left && left.components && left.components['presentation-ray'];
    if (presentationRay && presentationRay.active) {
      return {
        hand: 'left',
        element: left,
        component: presentationRay,
        color: '#FF3B30'
      };
    }

    var triggerRay = right && right.components && right.components['trigger-ray'];
    if (triggerRay && triggerRay.active) {
      var raycaster = right.components && right.components.raycaster;
      var raycasterData = raycaster && raycaster.data;
      return {
        hand: 'right',
        element: right,
        component: triggerRay,
        color: String((raycasterData && raycasterData.lineColor) || '#38BDF8')
      };
    }

    return null;
  }

  function activeRayPayload(left, right) {
    var activeRay = resolveActiveRay(left, right);
    if (!activeRay || !activeRay.element || !activeRay.element.object3D) {
      return { active: false, hand: '', start: null, end: null, color: '' };
    }

    var start = new THREE.Vector3();
    var end = new THREE.Vector3();
    var quaternion = new THREE.Quaternion();
    activeRay.element.object3D.getWorldPosition(start);

    if (activeRay.component.currentIntersection && activeRay.component.currentIntersection.point) {
      end.copy(activeRay.component.currentIntersection.point);
    } else {
      activeRay.element.object3D.getWorldQuaternion(quaternion);
      end.copy(start).add(new THREE.Vector3(0, 0, -3).applyQuaternion(quaternion));
    }

    return {
      active: true,
      hand: activeRay.hand,
      start: vec3Array(start),
      end: vec3Array(end),
      color: activeRay.color
    };
  }

  function sendLocalPose() {
    if (!isImmersive()) return;
    var camera = document.getElementById('camera');
    var left = document.getElementById('leftHand');
    var right = document.getElementById('rightHand');
    var headPose = worldPose(camera);
    var leftPose = worldPose(left);
    var rightPose = worldPose(right);
    if (!headPose || !rightPose) return;

    var ray = activeRayPayload(left, right);

    send('pose', {
      id: CLIENT_ID,
      name: USER_NAME,
      role: ROLE,
      color: COLOR,
      head: headPose,
      left: leftPose,
      right: rightPose,
      rayActive: ray.active,
      rayHand: ray.hand,
      rayStart: ray.start,
      rayEnd: ray.end,
      rayColor: ray.color
    });
  }

  function onRemotePose(payload) {
    if (!payload.id || payload.id === CLIENT_ID || !payload.head) return;
    var avatar = ensureAvatar(payload.id, payload);
    applyPose(avatar.head, payload.head);
    if (payload.left) { avatar.left.object3D.visible = true; applyPose(avatar.left, payload.left); }
    else avatar.left.object3D.visible = false;
    if (payload.right) { avatar.right.object3D.visible = true; applyPose(avatar.right, payload.right); }
    else avatar.right.object3D.visible = false;

    var headPosition = arrayVec3(payload.head.p);
    avatar.label.object3D.position.copy(headPosition).add(new THREE.Vector3(0, 0.22, 0));
    avatar.label.setAttribute('value', sanitizeName(payload.name || 'Użytkownik'));

    var fallbackPose = payload.rayHand === 'left' ? payload.left : payload.right;
    var rayStart = payload.rayStart || (fallbackPose && fallbackPose.p);
    if (payload.rayActive && rayStart && payload.rayEnd) {
      avatar.laser.object3D.visible = true;
      avatar.laser.setAttribute('line', {
        start: arrayVec3(rayStart),
        end: arrayVec3(payload.rayEnd),
        color: payload.rayColor || payload.color || avatar.color,
        opacity: 0.96
      });
    } else {
      avatar.laser.object3D.visible = false;
    }
    avatar.lastSeen = Date.now();
  }

  function ensureAvatar(id, payload) {
    if (remoteAvatars.has(id)) return remoteAvatars.get(id);
    var color = payload.color || colorFor(id);
    var root = document.createElement('a-entity');
    root.setAttribute('data-collab-user', id);

    var head = document.createElement('a-sphere');
    head.setAttribute('radius', '0.105');
    head.setAttribute('color', color);
    head.setAttribute('material', 'shader: flat; transparent: true; opacity: 0.92; depthTest: false');
    head.setAttribute('segments-width', '16');
    head.setAttribute('segments-height', '12');

    var left = document.createElement('a-box');
    left.setAttribute('width', '0.065'); left.setAttribute('height', '0.045'); left.setAttribute('depth', '0.12');
    left.setAttribute('color', color); left.setAttribute('material', 'shader: flat; depthTest: false');

    var right = document.createElement('a-box');
    right.setAttribute('width', '0.065'); right.setAttribute('height', '0.045'); right.setAttribute('depth', '0.12');
    right.setAttribute('color', color); right.setAttribute('material', 'shader: flat; depthTest: false');

    var laser = document.createElement('a-entity');
    laser.setAttribute('line', 'start: 0 0 0; end: 0 0 -1; color: ' + color + '; opacity: 0.92');

    var label = document.createElement('a-text');
    label.setAttribute('value', sanitizeName(payload.name || 'Użytkownik'));
    label.setAttribute('align', 'center');
    label.setAttribute('anchor', 'center');
    label.setAttribute('width', '1.5');
    label.setAttribute('color', color);
    label.setAttribute('look-at-camera', 'camera: #camera; yawOnly: false');
    label.setAttribute('material', 'depthTest: false');

    root.appendChild(head); root.appendChild(left); root.appendChild(right); root.appendChild(laser); root.appendChild(label);
    scene.appendChild(root);

    var avatar = { root: root, head: head, left: left, right: right, laser: laser, label: label, color: color, lastSeen: Date.now() };
    remoteAvatars.set(id, avatar);
    return avatar;
  }

  function removeAvatar(id) {
    var avatar = remoteAvatars.get(id);
    if (!avatar) return;
    if (avatar.root && avatar.root.parentNode) avatar.root.parentNode.removeChild(avatar.root);
    remoteAvatars.delete(id);
  }

  function applyPose(element, pose) {
    if (!element || !element.object3D || !pose) return;
    element.object3D.position.copy(arrayVec3(pose.p));
    element.object3D.quaternion.copy(arrayQuat(pose.q));
  }

  function patchComponentsWhenReady() {
    var attempts = 0;
    var timer = window.setInterval(function () {
      attempts += 1;
      var selection = scene && scene.components && scene.components['component-selection'];
      var measurement = scene && scene.components && scene.components['measurement-tool'];
      var annotation = scene && scene.components && scene.components['annotation-control'];
      var viewer = scene && scene.components && scene.components['quest-viewer'];

      if (selection && measurement && annotation && viewer) {
        window.clearInterval(timer);
        patchComponents(selection, measurement, annotation, viewer);
      } else if (attempts > 300) {
        window.clearInterval(timer);
        setUiNote('Połączenie działa, ale nie udało się podłączyć synchronizacji narzędzi. Odśwież stronę.');
      }
    }, 100);
  }

  function patchComponents(selection, measurement, annotation, viewer) {
    if (patchReady) return;
    patchReady = true;

    patchSelection(selection);
    patchMeasurement(measurement);
    patchAnnotation(annotation);

    scene.addEventListener('viewer-ui-action', function (event) {
      if (suppress) return;
      var detail = event.detail || {};
      var allowed = {
        'component-hide': true,
        'component-show': true,
        'component-isolate': true,
        'component-show-all': true,
        'component-edges': true,
        'lighting-global': true,
        'lighting-reset': true,
        'annotation-undo': true,
        'annotation-clear': true
      };
      if (allowed[detail.action]) {
        var actionPayload = { action: detail.action, value: Number(detail.value) || 0 };
        if (detail.action === 'component-hide' || detail.action === 'component-show' || detail.action === 'component-isolate') {
          var currentSelection = scene.components && scene.components['component-selection'];
          actionPayload.selected = currentSelection ? Array.from(currentSelection.selected || []) : [];
        }
        if (detail.action === 'annotation-clear') remoteStrokes.clear();
        send('action', actionPayload);
      }
    });

    window.addEventListener('moja-scale-changed', function (event) {
      if (suppress) return;
      var percent = event && event.detail ? Number(event.detail.percent) : NaN;
      if (Number.isFinite(percent)) send('scale', { percent: percent });
    });

    if (ROLE !== 'host') {
      requestState();
      window.setTimeout(requestState, 2500);
    }
  }

  function patchSelection(selection) {
    if (selection.__mojaCollabPatched) return;
    selection.__mojaCollabPatched = true;
    var originalToggle = selection.toggleIndex.bind(selection);
    var originalClear = selection.clearSelection.bind(selection);

    selection.toggleIndex = function (index, reveal) {
      var result = originalToggle(index, reveal);
      if (!suppress) {
        send('selection', {
          index: Math.round(index),
          selected: selection.selected.has(Math.round(index)),
          reveal: Boolean(reveal)
        });
      }
      return result;
    };

    selection.clearSelection = function (render) {
      var hadSelection = Boolean(selection.selected && selection.selected.size);
      var result = originalClear(render);
      if (hadSelection && !suppress) send('selection-clear', {});
      return result;
    };
  }

  function patchMeasurement(measurement) {
    if (measurement.__mojaCollabPatched) return;
    measurement.__mojaCollabPatched = true;

    var originalAdd = measurement.addIntersection.bind(measurement);
    measurement.addIntersection = function (intersection) {
      var result = originalAdd(intersection);
      if (result && !suppress) {
        var point = measurement.points[1] || measurement.points[0];
        if (point) send('measurement-point', { point: serializeStoredPoint(point) });
      }
      return result;
    };

    var originalClear = measurement.clear.bind(measurement);
    measurement.clear = function () {
      var hadPoint = Boolean(measurement.points && (measurement.points[0] || measurement.points[1]));
      var result = originalClear();
      if (hadPoint && !suppress) send('measurement-clear', {});
      return result;
    };
  }

  function patchAnnotation(annotation) {
    if (annotation.__mojaCollabPatched) return;
    annotation.__mojaCollabPatched = true;

    var originalBegin = annotation.beginStroke.bind(annotation);
    annotation.beginStroke = function () {
      var result = originalBegin();
      if (!suppress && annotation.currentStroke) {
        annotation.__mojaCollabStrokeId = CLIENT_ID + '-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
        send('annotation-stroke-start', {
          strokeId: annotation.__mojaCollabStrokeId,
          color: annotation.color,
          thicknessMm: annotation.thicknessMm
        });
      }
      return result;
    };

    var originalSegment = annotation.addStrokeSegment.bind(annotation);
    annotation.addStrokeSegment = function (a, b) {
      var before = annotation.currentStroke ? annotation.currentStroke.children.length : 0;
      var result = originalSegment(a, b);
      var after = annotation.currentStroke ? annotation.currentStroke.children.length : 0;
      if (!suppress && annotation.__mojaCollabStrokeId && after > before) {
        send('annotation-stroke-segment', {
          strokeId: annotation.__mojaCollabStrokeId,
          a: vec3Array(a),
          b: vec3Array(b),
          color: annotation.color,
          thicknessMm: annotation.thicknessMm
        });
      }
      return result;
    };

    var originalFinish = annotation.finishStroke.bind(annotation);
    annotation.finishStroke = function () {
      var strokeId = annotation.__mojaCollabStrokeId;
      var result = originalFinish();
      if (!suppress && strokeId) send('annotation-stroke-end', { strokeId: strokeId });
      annotation.__mojaCollabStrokeId = null;
      return result;
    };

    var originalPlaceText = annotation.placeText.bind(annotation);
    annotation.placeText = function () {
      var before = annotation.items.length;
      var value = String(annotation.textBuffer || '').trim() || 'UWAGA';
      var result = originalPlaceText();
      if (!suppress && annotation.items.length > before) {
        var item = annotation.items[annotation.items.length - 1];
        if (item && item.object) {
          send('annotation-text', {
            value: value,
            position: vec3Array(item.object.position),
            color: annotation.color,
            textSizeMm: annotation.textSizeMm
          });
        }
      }
      return result;
    };
  }

  function onRemoteAction(payload) {
    if (!payload.action) return;
    if (payload.action === 'annotation-clear') remoteStrokes.clear();
    withSuppress(function () {
      if (Array.isArray(payload.selected)) {
        var selection = scene.components && scene.components['component-selection'];
        if (selection && selection.built) {
          selection.selected.clear();
          payload.selected.forEach(function (index) {
            if (Number.isInteger(index) && selection.treeNodes[index]) selection.selected.add(index);
          });
          if (selection.syncHelpers) selection.syncHelpers();
          if (selection.renderPanel) selection.renderPanel();
        }
      }
      scene.emit('viewer-ui-action', { action: payload.action, value: Number(payload.value) || 0, source: null }, false);
    });
  }

  function onRemoteSelection(payload) {
    var selection = scene && scene.components && scene.components['component-selection'];
    if (!selection || !selection.built) return;
    var index = Math.round(Number(payload.index));
    if (!Number.isInteger(index) || index < 0 || index >= selection.treeNodes.length) return;
    withSuppress(function () {
      var isSelected = selection.selected.has(index);
      if (Boolean(payload.selected) !== isSelected) selection.toggleIndex(index, Boolean(payload.reveal));
    });
  }

  function onRemoteSelectionClear() {
    var selection = scene && scene.components && scene.components['component-selection'];
    if (!selection || !selection.built) return;
    withSuppress(function () { selection.clearSelection(); });
  }

  function onRemoteScale(payload) {
    var viewer = scene && scene.components && scene.components['quest-viewer'];
    var percent = Number(payload.percent);
    if (!viewer || !Number.isFinite(percent)) return;
    withSuppress(function () { viewer.setScalePercent(percent, true); });
  }

  function onRemoteMeasurementPoint(payload) {
    var measurement = scene && scene.components && scene.components['measurement-tool'];
    if (!measurement || !payload.point) return;
    withSuppress(function () {
      if (measurement.points[0] && measurement.points[1]) measurement.clear();
      var point = deserializeStoredPoint(payload.point);
      if (!measurement.points[0]) measurement.points[0] = point;
      else measurement.points[1] = point;
      measurement.updateVisual();
    });
  }

  function onRemoteMeasurementClear() {
    var measurement = scene && scene.components && scene.components['measurement-tool'];
    if (!measurement) return;
    withSuppress(function () { measurement.clear(); });
  }

  function onRemoteStrokeStart(payload) {
    var annotation = scene && scene.components && scene.components['annotation-control'];
    if (!annotation || !annotation.data.root || !payload.strokeId) return;
    var key = payload.sender + ':' + payload.strokeId;
    if (remoteStrokes.has(key)) return;

    var group = new THREE.Group();
    group.name = '__MOJA_REMOTE_ANNOTATION_STROKE__';
    annotation.data.root.object3D.add(group);
    annotation.items.push({ type: 'stroke', object: group });
    remoteStrokes.set(key, {
      group: group,
      color: payload.color || '#FF3B30',
      thicknessMm: Number(payload.thicknessMm) || 10
    });
  }

  function onRemoteStrokeSegment(payload) {
    var key = payload.sender + ':' + payload.strokeId;
    var stroke = remoteStrokes.get(key);
    if (!stroke) {
      onRemoteStrokeStart(payload);
      stroke = remoteStrokes.get(key);
    }
    if (!stroke || !payload.a || !payload.b) return;

    var a = arrayVec3(payload.a);
    var b = arrayVec3(payload.b);
    var distance = a.distanceTo(b);
    if (!Number.isFinite(distance) || distance < 0.004) return;
    var radius = Math.max(0.001, (Number(payload.thicknessMm) || stroke.thicknessMm) / 2000);
    var geometry = new THREE.CylinderGeometry(radius, radius, distance, 8, 1, false);
    var material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(payload.color || stroke.color),
      depthTest: true,
      depthWrite: true,
      toneMapped: false
    });
    var mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    mesh.renderOrder = 12;
    stroke.group.add(mesh);
  }

  function onRemoteStrokeEnd(payload) {
    var key = payload.sender + ':' + payload.strokeId;
    var stroke = remoteStrokes.get(key);
    remoteStrokes.delete(key);

    // Jeżeli użytkownik tylko nacisnął trigger i nie narysował odcinka,
    // usuń pustą pozycję. Dzięki temu stos UNDO pozostaje taki sam u obu osób.
    if (!stroke || !stroke.group || stroke.group.children.length > 0) return;
    var annotation = scene && scene.components && scene.components['annotation-control'];
    if (!annotation) return;
    if (stroke.group.parent) stroke.group.parent.remove(stroke.group);
    annotation.items = annotation.items.filter(function (item) { return item && item.object !== stroke.group; });
  }

  function onRemoteText(payload) {
    var annotation = scene && scene.components && scene.components['annotation-control'];
    if (!annotation || !annotation.data.root || !payload.position) return;
    withSuppress(function () {
      var oldColor = annotation.color;
      var oldSize = annotation.textSizeMm;
      annotation.color = payload.color || oldColor;
      annotation.textSizeMm = Number(payload.textSizeMm) || oldSize;
      var sprite = annotation.createTextSprite(String(payload.value || 'UWAGA'));
      sprite.position.copy(arrayVec3(payload.position));
      annotation.data.root.object3D.add(sprite);
      annotation.items.push({ type: 'text-sprite', object: sprite });
      annotation.color = oldColor;
      annotation.textSizeMm = oldSize;
    });
  }

  function sendModelTransform() {
    if (!isImmersive()) return;
    var pivot = document.getElementById('modelPivot');
    var viewer = scene && scene.components && scene.components['quest-viewer'];
    if (!pivot || !viewer || !viewer.ready) return;
    send('model-transform', {
      mode: String(window.QUEST_MODE || 'vr'),
      position: vec3Array(pivot.object3D.position),
      quaternion: quatArray(pivot.object3D.quaternion),
      scale: vec3Array(pivot.object3D.scale),
      visible: Boolean(pivot.object3D.visible)
    });
  }

  function onRemoteModelTransform(payload) {
    if (ROLE === 'host' || !FOLLOW || payload.senderRole !== 'host') return;
    if (String(payload.mode || '') !== String(window.QUEST_MODE || 'vr')) return;
    var pivot = document.getElementById('modelPivot');
    var viewer = scene && scene.components && scene.components['quest-viewer'];
    if (!pivot || !viewer || !viewer.ready) return;
    withSuppress(function () {
      if (payload.position) pivot.object3D.position.copy(arrayVec3(payload.position));
      if (payload.quaternion) pivot.object3D.quaternion.copy(arrayQuat(payload.quaternion));
      if (payload.scale) pivot.object3D.scale.copy(arrayVec3(payload.scale));
      pivot.object3D.visible = payload.visible !== false;
      viewer.placed = true;
      if (viewer.updateInfo) viewer.updateInfo();
    });
  }

  function requestState() {
    lastStateRequestAt = Date.now();
    send('state-request', { requester: CLIENT_ID });
  }

  function onStateRequest(payload) {
    if (ROLE !== 'host' || !payload.requester) return;
    send('state-snapshot', { target: payload.requester, snapshot: buildSnapshot() });
  }

  function buildSnapshot() {
    var selection = scene && scene.components && scene.components['component-selection'];
    var measurement = scene && scene.components && scene.components['measurement-tool'];
    var viewer = scene && scene.components && scene.components['quest-viewer'];
    var pivot = document.getElementById('modelPivot');
    var hidden = [];

    if (selection && Array.isArray(selection.meshes)) {
      selection.meshes.forEach(function (mesh, index) { if (!mesh.visible) hidden.push(index); });
    }

    return {
      hiddenMeshes: hidden,
      selected: selection ? Array.from(selection.selected || []) : [],
      edgesVisible: selection ? Boolean(selection.edgesVisible) : true,
      scalePercent: viewer ? Number(viewer.scalePercent) || 100 : 100,
      measurement: measurement ? measurement.points.map(serializeStoredPoint) : [null, null],
      pivot: pivot ? {
        position: vec3Array(pivot.object3D.position),
        quaternion: quatArray(pivot.object3D.quaternion),
        scale: vec3Array(pivot.object3D.scale),
        visible: Boolean(pivot.object3D.visible)
      } : null,
      mode: String(window.QUEST_MODE || 'vr')
    };
  }

  function onStateSnapshot(payload) {
    if (payload.target !== CLIENT_ID || !payload.snapshot) return;
    applySnapshotWhenReady(payload.snapshot, 0);
  }

  function applySnapshotWhenReady(snapshot, attempt) {
    var selection = scene && scene.components && scene.components['component-selection'];
    var viewer = scene && scene.components && scene.components['quest-viewer'];
    if ((!selection || !selection.built || !viewer || !viewer.ready) && attempt < 100) {
      window.setTimeout(function () { applySnapshotWhenReady(snapshot, attempt + 1); }, 100);
      return;
    }
    if (!selection || !viewer) return;

    withSuppress(function () {
      selection.meshes.forEach(function (mesh) { mesh.visible = true; });
      (snapshot.hiddenMeshes || []).forEach(function (index) {
        if (selection.meshes[index]) selection.meshes[index].visible = false;
      });

      selection.selected.clear();
      (snapshot.selected || []).forEach(function (index) {
        if (Number.isInteger(index) && selection.treeNodes[index]) selection.selected.add(index);
      });
      if (selection.syncHelpers) selection.syncHelpers();
      if (selection.renderPanel) selection.renderPanel();
      if (selection.refreshRaycaster) selection.refreshRaycaster();

      if (typeof snapshot.edgesVisible === 'boolean' && snapshot.edgesVisible !== selection.edgesVisible) {
        selection.edgesVisible = snapshot.edgesVisible;
        var root = selection.asset && selection.asset.getObject3D('mesh');
        if (window.MOJA && window.MOJA.setEdgesVisible) window.MOJA.setEdgesVisible(root, selection.edgesVisible);
      }

      if (Number.isFinite(Number(snapshot.scalePercent))) viewer.setScalePercent(Number(snapshot.scalePercent), true);

      var measurement = scene.components['measurement-tool'];
      if (measurement && Array.isArray(snapshot.measurement)) {
        measurement.points = [deserializeStoredPoint(snapshot.measurement[0]), deserializeStoredPoint(snapshot.measurement[1])];
        measurement.updateVisual();
      }

      var pivot = document.getElementById('modelPivot');
      if (pivot && snapshot.pivot && snapshot.mode === String(window.QUEST_MODE || 'vr') && FOLLOW) {
        pivot.object3D.position.copy(arrayVec3(snapshot.pivot.position));
        pivot.object3D.quaternion.copy(arrayQuat(snapshot.pivot.quaternion));
        pivot.object3D.scale.copy(arrayVec3(snapshot.pivot.scale));
        pivot.object3D.visible = snapshot.pivot.visible !== false;
        viewer.placed = true;
      }
    });
    setUiNote('Stan prowadzącego został zsynchronizowany.');
  }

  function serializeStoredPoint(point) {
    if (!point || !point.value) return null;
    return { space: point.space === 'target' ? 'target' : 'world', value: vec3Array(point.value) };
  }

  function deserializeStoredPoint(point) {
    if (!point || !point.value) return null;
    return { space: point.space === 'target' ? 'target' : 'world', value: arrayVec3(point.value) };
  }

  function withSuppress(callback) {
    var previous = suppress;
    suppress = true;
    try { callback(); } finally { suppress = previous; }
  }

  function vec3Array(vector) {
    return [round4(vector.x), round4(vector.y), round4(vector.z)];
  }

  function quatArray(quaternion) {
    return [round5(quaternion.x), round5(quaternion.y), round5(quaternion.z), round5(quaternion.w)];
  }

  function arrayVec3(values) {
    values = Array.isArray(values) ? values : [0, 0, 0];
    return new THREE.Vector3(Number(values[0]) || 0, Number(values[1]) || 0, Number(values[2]) || 0);
  }

  function arrayQuat(values) {
    values = Array.isArray(values) ? values : [0, 0, 0, 1];
    return new THREE.Quaternion(Number(values[0]) || 0, Number(values[1]) || 0, Number(values[2]) || 0, Number(values[3]) || 1);
  }

  function round4(value) { return Math.round(Number(value) * 10000) / 10000; }
  function round5(value) { return Math.round(Number(value) * 100000) / 100000; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function sanitizeRoom(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 64);
  }

  function sanitizeName(value) {
    return String(value || '').trim().replace(/[<>]/g, '').slice(0, 32) || 'Użytkownik';
  }

  function compact(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function createClientId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    } catch (error) {
      return 'client-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    }
  }

  function colorFor(value) {
    var colors = ['#38BDF8', '#A78BFA', '#34D399', '#F59E0B', '#F472B6', '#FB7185', '#22D3EE'];
    var hash = 0;
    String(value || '').split('').forEach(function (character) { hash = ((hash << 5) - hash) + character.charCodeAt(0); hash |= 0; });
    return colors[Math.abs(hash) % colors.length];
  }

  function safeStorageGet(name) {
    try { return window.localStorage.getItem(name); } catch (error) { return null; }
  }

  function safeStorageSet(name, value) {
    try { window.localStorage.setItem(name, value); } catch (error) {}
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character];
    });
  }

  window.addEventListener('beforeunload', function () {
    stopIntervals();
    try { if (channel) channel.untrack(); } catch (error) {}
    try { if (supabaseClient && channel) supabaseClient.removeChannel(channel); } catch (error) {}
  });
})();
