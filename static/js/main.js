const tg = window.Telegram.WebApp;

// DOM Elements
const userList = document.getElementById('user-list');
const callHistoryList = document.getElementById('call-history-list');
const connectionStatus = document.getElementById('connection-status');
const mainScreen = document.getElementById('main-screen');
const privateCallScreen = document.getElementById('private-call-screen');
const privateCallStatusText = document.getElementById('private-call-status-text');
const privateCallButtons = document.getElementById('private-call-buttons-container');
const callScreen = document.getElementById('call-screen');
const incomingCallModal = document.getElementById('incoming-call-modal');
const callerName = document.getElementById('caller-name');
const incomingCallType = document.getElementById('incoming-call-type');
const acceptBtn = document.getElementById('accept-btn');
const declineBtn = document.getElementById('decline-btn');
const hangupBtn = document.getElementById('hangup-btn');
const remoteUserName = document.getElementById('remote-user-name');
const callTimer = document.getElementById('call-timer');
const speakerBtn = document.getElementById('speaker-btn');
const muteBtn = document.getElementById('mute-btn');
const videoBtn = document.getElementById('video-btn');
const videoControlItem = document.getElementById('video-control-item');
const localAudio = document.getElementById('localAudio');
const remoteAudio = document.getElementById('remoteAudio');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const ringOutAudio = document.getElementById('ringOutAudio');
const connectAudio = document.getElementById('connectAudio');
const ringInAudio = document.getElementById('ringInAudio');

// State
let ws;
let peerConnection;
let localStream;
let remoteStream;
let currentUser = {};
let targetUser = {};
let currentCallType = 'audio';
let callTimerInterval;
let isSpeaker = false;
let isMuted = false;
let isVideoEnabled = true;
let roomId = 'private'; // Default for TG mode, will be overwritten
let encodedInitData = '';
let currentCallLog = null;
let appMode = 'TMA'; // 'TMA', 'PRIVATE_INIT', 'PRIVATE_CALL'

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

function sendLogToServer(message) {
    if (!currentUser || !currentUser.id || !roomId) return;
    fetch('/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            user_id: String(currentUser.id),
            room_id: String(roomId),
            message: message
        })
    }).catch(error => console.error('Failed to send log to server:', error));
}

function logToScreen(message) {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const logMessage = `[${time}] ${message}`;
    console.log(logMessage);
    sendLogToServer(logMessage);
}

// --- App Initialization and Mode Routing ---

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;
    logToScreen(`App loaded. Path: ${path}`);

    if (path.startsWith('/call/')) {
        appMode = 'PRIVATE_CALL';
        const parts = path.split('/');
        roomId = parts[2];
        initializePrivateCallMode();
    } else if (path === '/init_private') {
        appMode = 'PRIVATE_INIT';
        initializeApp(initializePrivateInitMode);
    } else {
        appMode = 'TMA';
        initializeApp(initializeTmaMode);
    }
});

function initializeApp(callback) {
    tg.ready();
    tg.expand();

    if (!tg.initData) {
        document.body.innerHTML = "<h1>Ошибка: Запустите приложение через Telegram.</h1>";
        logToScreen("CRITICAL ERROR: tg.initData is missing.");
        return;
    }
    try {
        encodedInitData = encodeURIComponent(tg.initData);
        const params = new URLSearchParams(tg.initData);
        currentUser = JSON.parse(params.get('user'));
        const urlParams = new URLSearchParams(window.location.search);
        roomId = urlParams.get('chat_id') || 'private'; // For TMA mode
        logToScreen(`User ${currentUser.id} authenticated.`);
        callback();
    } catch (e) {
        document.body.innerHTML = "<h1>Ошибка: Неверные данные пользователя.</h1>";
        logToScreen(`CRITICAL ERROR: Failed to parse initData: ${e}`);
    }
}

// --- Mode-specific Initializers ---

function initializeTmaMode() {
    logToScreen("Initializing in TMA mode.");
    showScreen('main');
    setupEventListeners();
    connectWebSocket();
}

async function initializePrivateInitMode() {
    logToScreen("Initializing in Private Link Init mode.");
    try {
        const response = await fetch('/create_private_room', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: currentUser.id })
        });
        if (!response.ok) {
            throw new Error(`Server error: ${response.statusText}`);
        }
        alert("Приватная ссылка отправлена вам в чат с ботом. Можете закрыть это окно.");
    } catch (error) {
        logToScreen(`Failed to create private room: ${error}`);
        alert("Не удалось создать приватную ссылку. Попробуйте позже.");
    } finally {
        tg.close();
    }
}

function initializePrivateCallMode() {
    logToScreen(`Initializing in Private Call mode for room: ${roomId}`);
    currentUser = { id: `anon-${Math.random().toString(36).substr(2, 9)}`, first_name: "Вы" };
    showScreen('private-call');
    setupEventListeners();
    connectWebSocket();
}

// --- UI Management ---

function showScreen(screenName) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    if (screenName) document.getElementById(`${screenName}-screen`).classList.add('active');
}

function showModal(modalName, show) {
    const modal = document.getElementById(`${modalName}-modal`);
    if (modal) modal.classList.toggle('active', show);
}

// --- WebSocket and Signaling ---

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl;

    if (appMode === 'TMA') {
        wsUrl = `${protocol}//${window.location.host}/ws/tg/${roomId}/${encodedInitData}`;
    } else { // PRIVATE_CALL
        wsUrl = `${protocol}//${window.location.host}/ws/private/${roomId}`;
    }

    logToScreen(`Connecting to WebSocket: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        logToScreen("[WS] WebSocket connection established.");
        if (connectionStatus) connectionStatus.textContent = "В сети";
    };
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        logToScreen(`[WS] Received message: ${message.type}`);
        switch (message.type) {
            case 'identity':
                currentUser.id = message.data.id;
                logToScreen(`[WS] Identity assigned by server: ${currentUser.id}`);
                break;
            case 'user_list': handleUserList(message.data); break;
            case 'incoming_call': handleIncomingCall(message.data); break;
            case 'call_accepted': startPeerConnection(targetUser.id, true); break;
            case 'offer': handleOffer(message.data); break;
            case 'answer': handleAnswer(message.data); break;
            case 'candidate': handleCandidate(message.data); break;
            case 'call_ended': endCall(false, 'ended_by_peer'); break;
            case 'call_missed': alert("Абонент не отвечает."); endCall(false, 'no_answer'); break;
            case 'room_expired': alert("Время жизни приватной комнаты истекло. Соединение будет разорвано."); endCall(false, 'expired'); break;
        }
    };
    ws.onclose = (event) => {
        logToScreen(`[WS] WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
        if (event.code === 1008 && (event.reason.includes("full") || event.reason.includes("not found"))) {
            document.body.innerHTML = `<h1>Ошибка подключения: ${event.reason}</h1>`;
            return;
        }
        if (connectionStatus) connectionStatus.textContent = "Переподключение...";
        setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = (error) => {
        logToScreen(`[WS] WebSocket error: ${error}`);
        ws.close();
    };
}

function sendMessage(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        logToScreen(`[WS] Sending message: ${message.type}`);
        ws.send(JSON.stringify(message));
    } else {
        logToScreen("[WS] ERROR: Attempted to send message on a closed connection.");
    }
}

function handleUserList(users) {
    if (appMode === 'TMA') {
        updateTmaUserList(users);
    } else if (appMode === 'PRIVATE_CALL') {
        updatePrivateCallUserList(users);
    }
}

function updateTmaUserList(users) {
    userList.innerHTML = '';
    users.forEach(user => {
        if (user.id === currentUser.id) return;
        const card = document.createElement('div');
        card.className = 'user-card';
        card.innerHTML = `
            <div class="user-details">
                <div class="user-status-dot ${user.status}"></div>
                <span class="user-name">${user.first_name} ${user.last_name || ''}</span>
            </div>
            <div class="call-buttons-container">
                <button class="call-btn-list audio" data-user-id="${user.id}" data-call-type="audio" ${user.status !== 'available' ? 'disabled' : ''}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.02.74-.25 1.02l-2.2 2.2z"/></svg>
                </button>
                <button class="call-btn-list video" data-user-id="${user.id}" data-call-type="video" ${user.status !== 'available' ? 'disabled' : ''}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
                </button>
            </div>
        `;
        card.querySelector('.call-buttons-container').addEventListener('click', (e) => {
            const button = e.target.closest('.call-btn-list');
            if (button && !button.disabled) {
                const targetId = parseInt(button.dataset.userId, 10);
                const callType = button.dataset.callType;
                const userToCall = users.find(u => u.id === targetId);
                if (userToCall) {
                    initiateCall(userToCall, callType);
                }
            }
        });
        userList.appendChild(card);
    });
}

function updatePrivateCallUserList(users) {
    const otherUsers = users.filter(u => u.id !== currentUser.id);
    if (otherUsers.length > 0) {
        targetUser = otherUsers[0];
        privateCallStatusText.textContent = "Собеседник подключился. Вы можете начать звонок.";
        privateCallButtons.style.display = 'flex';
    } else {
        targetUser = {};
        privateCallStatusText.textContent = "Ожидание подключения собеседника...";
        privateCallButtons.style.display = 'none';
    }
}

// --- WebRTC and Call Logic ---

async function initiateCall(userToCall, callType) {
    logToScreen(`[CALL] Initiating call to user ${userToCall.id}, type: ${callType}`);

    // Unlock media elements on user gesture
    remoteAudio.play().catch(() => {});
    remoteVideo.play().catch(() => {});

    currentCallType = callType;
    const hasMedia = await initializeLocalMedia(currentCallType === 'video');

    if (!hasMedia) {
        logToScreen("[CALL] Failed to start call due to no media access.");
        return;
    }

    targetUser = userToCall;
    if (appMode === 'TMA') {
        currentCallLog = {
            user: targetUser,
            type: currentCallType,
            direction: 'outgoing',
            timestamp: new Date().toISOString(),
            status: 'initiated'
        };
    }

    sendMessage({ type: 'call_user', data: { target_id: targetUser.id, call_type: currentCallType } });

    showScreen('call');
    updateCallUI();
    callTimer.textContent = "Вызов...";
    ringOutAudio.play();
}

function handleIncomingCall(data) {
    logToScreen(`[CALL] Incoming call from ${data.from_user.id}, type: ${data.call_type}`);
    targetUser = data.from_user;
    currentCallType = data.call_type;

    if (appMode === 'TMA') {
        currentCallLog = {
            user: targetUser,
            type: currentCallType,
            direction: 'incoming',
            timestamp: new Date().toISOString(),
            status: 'initiated'
        };
    }

    callerName.textContent = `${targetUser.first_name} ${targetUser.last_name || ''}`;
    incomingCallType.textContent = currentCallType === 'video' ? 'Входящий видеозвонок' : 'Входящий аудиозвонок';
    showModal('incoming-call', true);
    ringInAudio.play();
}

async function acceptCall() {
    logToScreen("[CALL] 'Accept' button pressed.");

    // Unlock media elements on user gesture
    remoteAudio.play().catch(() => {});
    remoteVideo.play().catch(() => {});

    stopIncomingRing();
    showModal('incoming-call', false);

    const hasMedia = await initializeLocalMedia(currentCallType === 'video');

    if (!hasMedia) {
        logToScreen("[CALL] No media access. Auto-declining call.");
        declineCall();
        return;
    }

    logToScreen("[CALL] Media access granted. Starting WebRTC connection.");
    await startPeerConnection(targetUser.id, false);
    sendMessage({ type: 'call_accepted', data: { target_id: targetUser.id } });
}

function declineCall() {
    logToScreen("[CALL] Declining call.");
    stopIncomingRing();
    showModal('incoming-call', false);
    sendMessage({ type: 'call_declined', data: { target_id: targetUser.id } });

    if (currentCallLog) {
        currentCallLog.status = 'declined';
        logCall(currentCallLog);
        currentCallLog = null;
    }

    targetUser = {};
}

function endCall(isInitiator, reason) {
    logToScreen(`[CALL] Ending call. Initiator: ${isInitiator}, Reason: ${reason}`);
    if (isInitiator && targetUser.id) {
        sendMessage({ type: 'hangup', data: { target_id: targetUser.id } });
    }

    if (currentCallLog) {
        if (callTimerInterval) {
            currentCallLog.status = 'answered';
            currentCallLog.duration = callTimer.textContent;
        } else if (reason === 'no_answer') {
            currentCallLog.status = 'no_answer';
        } else if (reason === 'cancelled' && currentCallLog.direction === 'outgoing') {
            currentCallLog.status = 'cancelled';
        } else if (currentCallLog.direction === 'incoming') {
            currentCallLog.status = 'missed';
        }
        logCall(currentCallLog);
        currentCallLog = null;
    }

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    ringOutAudio.pause(); ringOutAudio.currentTime = 0;
    stopIncomingRing();

    localAudio.srcObject = null;
    remoteAudio.srcObject = null;
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    localVideo.style.display = 'none';
    remoteVideo.style.display = 'none';

    stopTimer();
    showModal('incoming-call', false);

    if (appMode === 'TMA') {
        showScreen('main');
    } else {
        showScreen('private-call');
    }

    targetUser = {};
    resetCallControls();
}

// --- Event Listeners Setup ---

function setupEventListeners() {
    speakerBtn.addEventListener('click', toggleSpeaker);
    muteBtn.addEventListener('click', toggleMute);
    videoBtn.addEventListener('click', toggleVideo);
    acceptBtn.addEventListener('click', acceptCall);
    declineBtn.addEventListener('click', declineCall);
    hangupBtn.addEventListener('click', () => endCall(true, 'cancelled'));

    if (appMode === 'TMA') {
        document.querySelector('.tabs').addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-btn')) {
                const tabName = e.target.dataset.tab;
                document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
                e.target.classList.add('active');
                document.getElementById(`${tabName}-pane`).classList.add('active');
                if (tabName === 'history') {
                    renderCallHistory();
                }
            }
        });
    } else if (appMode === 'PRIVATE_CALL') {
        privateCallButtons.addEventListener('click', (e) => {
            const button = e.target.closest('.call-btn-list');
            if (button && targetUser.id) {
                const callType = button.dataset.callType;
                initiateCall(targetUser, callType);
            }
        });
    }
}

// --- Media and PeerConnection ---

async function initializeLocalMedia(isVideo) {
    logToScreen(`[MEDIA] Requesting media access. Video: ${isVideo}`);
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    const constraints = { audio: true, video: isVideo };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        logToScreen("[MEDIA] Media access granted.");
        localAudio.srcObject = localStream;
        if (isVideo && localStream.getVideoTracks().length > 0) {
            localVideo.srcObject = localStream;
            await localVideo.play();
            localVideo.style.display = 'block';
            isVideoEnabled = true;
        } else {
            localVideo.style.display = 'none';
            isVideoEnabled = false;
            if (isVideo) {
                logToScreen("[MEDIA] WARNING: Video requested but no video track found.");
                currentCallType = 'audio';
            }
        }
        return true;
    } catch (error) {
        logToScreen(`[MEDIA] ERROR getting media: ${error.name} - ${error.message}`);
        alert(`Ошибка доступа к камере/микрофону: ${error.name}. Проверьте разрешения в настройках браузера/устройства.`);
        return false;
    }
}

async function createPeerConnection() {
    logToScreen("[WEBRTC] Creating RTCPeerConnection.");
    if (peerConnection) peerConnection.close();
    peerConnection = new RTCPeerConnection(rtcConfig);
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;
    remoteAudio.srcObject = remoteStream;

    peerConnection.oniceconnectionstatechange = () => logToScreen(`[WEBRTC] ICE State: ${peerConnection.iceConnectionState}`);
    peerConnection.onsignalingstatechange = () => logToScreen(`[WEBRTC] Signaling State: ${peerConnection.signalingState}`);
    peerConnection.onicecandidate = event => {
        if (event.candidate) sendMessage({ type: 'candidate', data: { target_id: targetUser.id, candidate: event.candidate } });
    };
    peerConnection.ontrack = event => {
        logToScreen(`[WEBRTC] Received remote track: ${event.track.kind}`);
        remoteStream.addTrack(event.track);
        if (event.track.kind === 'video') {
            remoteVideo.style.display = 'block';
            remoteVideo.play().catch(e => logToScreen(`[VIDEO PLAY] Error playing remote video: ${e}`));
        }
    };
    if (localStream) {
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    } else {
        logToScreen("[WEBRTC] CRITICAL ERROR: localStream is not defined!");
        endCall(true, 'error');
    }
}

async function startPeerConnection(targetId, isCaller) {
    logToScreen(`[WEBRTC] Starting PeerConnection. Is caller: ${isCaller}`);
    ringOutAudio.pause(); ringOutAudio.currentTime = 0;
    targetUser.id = targetId;
    await createPeerConnection();
    if (isCaller) {
        logToScreen("[WEBRTC] Creating Offer.");
        const offer = await peerConnection.createOffer({ offerToReceiveAudio: 1, offerToReceiveVideo: currentCallType === 'video' ? 1 : 0 });
        await peerConnection.setLocalDescription(offer);
        sendMessage({ type: 'offer', data: { target_id: targetId, offer: offer } });
    }
}

async function handleOffer(data) {
    logToScreen("[WEBRTC] Received Offer, creating Answer.");
    if (!peerConnection) await startPeerConnection(data.from, false);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendMessage({ type: 'answer', data: { target_id: data.from, answer: answer } });
    showScreen('call');
    updateCallUI();
    startTimer();
    connectAudio.play();
}

async function handleAnswer(data) {
    logToScreen("[WEBRTC] Received Answer.");
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        startTimer();
        connectAudio.play();
    }
}

async function handleCandidate(data) {
    if (peerConnection && data.candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            logToScreen(`[WEBRTC] ERROR adding ICE candidate: ${e}`);
        }
    }
}

// --- Call Controls and UI Helpers ---

function stopIncomingRing() {
    ringInAudio.pause();
    ringInAudio.currentTime = 0;
}

function updateCallUI() {
    remoteUserName.textContent = `${targetUser.first_name} ${targetUser.last_name || ''}`;
    videoControlItem.style.display = currentCallType === 'video' ? 'flex' : 'none';
    callScreen.style.backgroundColor = currentCallType === 'video' ? '#000' : '#1c1c1e';
}

function toggleMute() {
    isMuted = !isMuted;
    if (localStream) localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    muteBtn.classList.toggle('active', isMuted);
    logToScreen(`[CONTROLS] Mic ${isMuted ? 'muted' : 'unmuted'}.`);
}

function toggleVideo() {
    isVideoEnabled = !isVideoEnabled;
    if (localStream) localStream.getVideoTracks().forEach(track => track.enabled = isVideoEnabled);
    videoBtn.classList.toggle('active', !isVideoEnabled);
    localVideo.style.display = isVideoEnabled ? 'block' : 'none';
    logToScreen(`[CONTROLS] Video ${isVideoEnabled ? 'enabled' : 'disabled'}.`);
}

async function toggleSpeaker() {
    isSpeaker = !isSpeaker;
    speakerBtn.classList.toggle('active', isSpeaker);
    logToScreen(`[CONTROLS] Speaker toggled. Note: This is a UI-only toggle as setSinkId is not universally supported.`);
}

function resetCallControls() {
    isMuted = false; isVideoEnabled = true; isSpeaker = false;
    muteBtn.classList.remove('active');
    videoBtn.classList.remove('active');
    speakerBtn.classList.remove('active');
}

function startTimer() {
    if (callTimerInterval) clearInterval(callTimerInterval);
    let seconds = 0;
    callTimer.textContent = '00:00';
    callTimerInterval = setInterval(() => {
        seconds++;
        const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
        const secs = String(seconds % 60).padStart(2, '0');
        callTimer.textContent = `${mins}:${secs}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
    callTimer.textContent = '00:00';
}

// --- History (TMA Mode only) ---

async function logCall(callData) {
    if (appMode !== 'TMA') return;
    try {
        await fetch(`/history/${encodedInitData}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(callData)
        });
    } catch (error) {
        logToScreen(`[HISTORY] Error saving history: ${error}`);
    }
}

async function renderCallHistory() {
    if (appMode !== 'TMA') return;
    callHistoryList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding-top: 20px;">Загрузка...</p>';
    try {
        const response = await fetch(`/history/${encodedInitData}`);
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const history = await response.json();
        callHistoryList.innerHTML = '';
        if (history.length === 0) {
            callHistoryList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding-top: 20px;">История вызовов пуста</p>';
            return;
        }
        history.forEach(call => {
            const item = document.createElement('div');
            item.className = 'call-history-item';

            const directionIcon = call.direction === 'outgoing'
                ? `<svg class="call-direction-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="17 17 17 7 7 7"></polyline></svg>`
                : `<svg class="call-direction-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 17 7 17 7 7"></polyline><line x1="17" y1="7" x2="7" y2="17"></line></svg>`;

            let statusText;
            let statusClass = '';
            switch (call.status) {
                case 'answered': statusText = call.duration; break;
                case 'missed': statusText = 'Пропущенный'; statusClass = 'missed'; break;
                case 'declined': statusText = 'Отклоненный'; statusClass = 'missed'; break;
                case 'no_answer': statusText = 'Нет ответа'; statusClass = 'missed'; break;
                default: statusText = 'Отмененный'; statusClass = 'missed';
            }

            const callTypeIcon = call.type === 'video'
                ? `<svg class="call-type-icon video" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`
                : `<svg class="call-type-icon audio" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.02.74-.25 1.02l-2.2 2.2z"/></svg>`;

            const callDate = new Date(call.timestamp);
            const formattedTime = callDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const formattedDate = callDate.toLocaleDateString([], { day: '2-digit', month: '2-digit' });

            item.innerHTML = `
                <div class="call-info-main">
                    <div class="user-name">${call.user.first_name} ${call.user.last_name || ''}</div>
                    <div class="call-status ${statusClass}">
                        ${directionIcon}
                        <span>${statusText}</span>
                    </div>
                </div>
                <div class="call-info-aside">
                    <span class="call-timestamp">${formattedDate} ${formattedTime}</span>
                    ${callTypeIcon}
                </div>
            `;
            callHistoryList.appendChild(item);
        });
    } catch (error) {
        logToScreen(`[HISTORY] Error fetching history: ${error}`);
        callHistoryList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding-top: 20px;">Не удалось загрузить историю</p>';
    }
}
