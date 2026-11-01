// WhatsApp Bot Web Linker - Frontend Client

const UI = {
  // Tabs
  tabCode: document.getElementById('tabCode'),
  tabQr: document.getElementById('tabQr'),

  // Cards
  cardPairing: document.getElementById('cardPairing'),
  cardCode: document.getElementById('cardCode'),
  cardQr: document.getElementById('cardQr'),

  // Success Notice
  connectionSuccessNotice: document.getElementById('connectionSuccessNotice'),
  successPhone: document.getElementById('successPhone'),

  // Form & inputs (Code de jumelage)
  pairForm: document.getElementById('pairForm'),
  phoneNumber: document.getElementById('phoneNumber'),
  btnGenerate: document.getElementById('btnGenerate'),
  btnLabel: document.querySelector('#btnGenerate .btn-label'),
  btnSpinner: document.querySelector('#btnGenerate .spinner'),
  alertBox: document.getElementById('alertBox'),
  alertMsg: document.getElementById('alertMsg'),

  // Code Card
  codeDisplay: document.getElementById('codeDisplay'),
  btnCopyCode: document.getElementById('btnCopyCode'),
  copyBtnText: document.getElementById('copyBtnText'),
  btnCancelPairing: document.getElementById('btnCancelPairing'),

  // QR Code Card
  qrLoading: document.getElementById('qrLoading'),
  qrImageWrapper: document.getElementById('qrImageWrapper'),
  qrImage: document.getElementById('qrImage'),
  qrErrorBox: document.getElementById('qrErrorBox'),
  qrErrorMsg: document.getElementById('qrErrorMsg'),
  btnRefreshQr: document.getElementById('btnRefreshQr'),

  toast: document.getElementById('toast'),
};

let currentPhonePending = null;
let rawPairingCode = '';
let pollTimer = null;
let activeQrSessionId = null;
let qrPollTimer = null;

// --- Navigation between views ---
function showView(viewName) {
  if (viewName === 'pairing') {
    UI.cardPairing.classList.add('active');
    UI.cardCode.classList.remove('active');
    UI.cardQr?.classList.remove('active');
    UI.tabCode?.classList.add('active');
    UI.tabQr?.classList.remove('active');
  } else if (viewName === 'code') {
    UI.cardPairing.classList.remove('active');
    UI.cardCode.classList.add('active');
    UI.cardQr?.classList.remove('active');
    UI.tabCode?.classList.add('active');
    UI.tabQr?.classList.remove('active');
  } else if (viewName === 'qr') {
    UI.cardPairing.classList.remove('active');
    UI.cardCode.classList.remove('active');
    UI.cardQr?.classList.add('active');
    UI.tabCode?.classList.remove('active');
    UI.tabQr?.classList.add('active');
  }
}

// --- Toast notification ---
function showToast(message) {
  if (!UI.toast) return;
  UI.toast.textContent = message;
  UI.toast.hidden = false;
  setTimeout(() => {
    UI.toast.hidden = true;
  }, 4000);
}

// --- Alerts (Pairing Form) ---
function showAlert(message) {
  UI.alertMsg.textContent = message;
  UI.alertBox.hidden = false;
}
function hideAlert() {
  UI.alertBox.hidden = true;
}

// --- Alerts (QR Code) ---
function showQrError(message) {
  if (!UI.qrErrorBox) return;
  UI.qrErrorMsg.textContent = message;
  UI.qrErrorBox.hidden = false;
}
function hideQrError() {
  if (UI.qrErrorBox) UI.qrErrorBox.hidden = true;
}

// --- Format Code Display ---
function formatPairingCode(code) {
  if (!code) return '---- ----';
  const clean = code.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length === 8) {
    return `${clean.slice(0, 4)} - ${clean.slice(4)}`;
  }
  return code;
}

// --- Vérifier si le numéro en cours est devenu connecté ---
async function checkPendingAccountStatus() {
  if (!currentPhonePending) return;

  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    if (data.success) {
      const accounts = data.accounts || [];
      const isNowConnected = accounts.some(
        a => a.phone.includes(currentPhonePending) && a.status === 'connected'
      );

      if (isNowConnected) {
        onPhoneConnectedSuccess(currentPhonePending);
      }
    }
  } catch (_) {}
}

// --- Quand un numéro s'est connecté avec succès (Pairing ou QR) ---
function onPhoneConnectedSuccess(phone) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
  activeQrSessionId = null;

  const displayPhone = phone ? `+${String(phone).replace(/[^0-9]/g, '')}` : 'WhatsApp';
  showToast(`🎉 ${displayPhone} a été connecté avec succès !`);

  if (UI.connectionSuccessNotice) {
    UI.connectionSuccessNotice.hidden = false;
    UI.successPhone.textContent = displayPhone;
  }

  // Réinitialiser les champs
  currentPhonePending = null;
  rawPairingCode = '';
  if (UI.phoneNumber) {
    UI.phoneNumber.value = '';
  }

  // Retour automatique vers la page du formulaire
  showView('pairing');
}

// --- Gestion des Tabs (Code vs QR) ---
if (UI.tabCode) {
  UI.tabCode.addEventListener('click', () => {
    cancelQrSession();
    showView(rawPairingCode ? 'code' : 'pairing');
  });
}

if (UI.tabQr) {
  UI.tabQr.addEventListener('click', () => {
    showView('qr');
    loadQrCode();
  });
}

// --- Annuler / Nettoyer une session QR ---
function cancelQrSession() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
  if (activeQrSessionId) {
    fetch('/api/qr/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeQrSessionId })
    }).catch(() => {});
    activeQrSessionId = null;
  }
}

// --- Charger / Générer un QR Code ---
async function loadQrCode() {
  cancelQrSession();
  hideQrError();

  if (UI.qrLoading) UI.qrLoading.hidden = false;
  if (UI.qrImageWrapper) UI.qrImageWrapper.hidden = true;
  if (UI.btnRefreshQr) UI.btnRefreshQr.disabled = true;

  try {
    const res = await fetch('/api/qr', { method: 'POST' });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Impossible de générer le QR Code.');
    }

    activeQrSessionId = data.sessionId;
    if (UI.qrImage) {
      UI.qrImage.src = data.qr;
    }

    if (UI.qrLoading) UI.qrLoading.hidden = true;
    if (UI.qrImageWrapper) UI.qrImageWrapper.hidden = false;

    // Polling du statut QR toutes les 2.5 secondes
    if (qrPollTimer) clearInterval(qrPollTimer);
    qrPollTimer = setInterval(checkQrStatus, 2500);

  } catch (err) {
    if (UI.qrLoading) UI.qrLoading.hidden = true;
    showQrError(err.message || 'Erreur lors de la génération du QR Code.');
  } finally {
    if (UI.btnRefreshQr) UI.btnRefreshQr.disabled = false;
  }
}

// --- Vérification du statut du scan QR ---
async function checkQrStatus() {
  if (!activeQrSessionId) return;

  try {
    const res = await fetch(`/api/qr/status?sessionId=${activeQrSessionId}`);
    const data = await res.json();

    if (data.success) {
      // Mettre à jour l'image si le QR a été renouvelé par WhatsApp
      if (data.qr && UI.qrImage && data.qr !== UI.qrImage.src) {
        UI.qrImage.src = data.qr;
      }

      // Si le statut est connected
      if (data.status === 'connected') {
        const cleanPhone = data.phone ? String(data.phone).replace(/[^0-9]/g, '') : null;
        onPhoneConnectedSuccess(cleanPhone);
      }
    }
  } catch (_) {}
}

// --- Bouton Recharger le QR Code ---
if (UI.btnRefreshQr) {
  UI.btnRefreshQr.addEventListener('click', () => {
    loadQrCode();
  });
}

// --- Gestion de la soumission du formulaire de pairing ---
if (UI.pairForm) {
  UI.pairForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const rawNum = UI.phoneNumber.value.trim();
    const cleanNum = rawNum.replace(/[^0-9]/g, '');

    if (!cleanNum || cleanNum.length < 8 || cleanNum.length > 15) {
      showAlert('Veuillez entrer un numéro valide avec indicatif pays (ex: 212612345678).');
      return;
    }

    // UI Loading state
    UI.btnGenerate.disabled = true;
    UI.btnLabel.textContent = 'Génération du code...';
    UI.btnSpinner.hidden = false;
    currentPhonePending = cleanNum;

    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: cleanNum })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Impossible de générer le code de liaison.');
      }

      rawPairingCode = data.code;
      UI.codeDisplay.textContent = formatPairingCode(data.code);
      showView('code');
      showToast('Code généré avec succès ! Saisissez-le sur WhatsApp.');

      // Lancer la vérification active toutes les 2 secondes
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(checkPendingAccountStatus, 2000);
    } catch (err) {
      showAlert(err.message || 'Erreur inconnue.');
      currentPhonePending = null;
    } finally {
      UI.btnGenerate.disabled = false;
      UI.btnLabel.textContent = 'Générer le code de liaison';
      UI.btnSpinner.hidden = true;
    }
  });
}

// --- Bouton Copier le code ---
if (UI.btnCopyCode) {
  UI.btnCopyCode.addEventListener('click', async () => {
    if (!rawPairingCode) return;
    try {
      await navigator.clipboard.writeText(rawPairingCode);
      UI.copyBtnText.textContent = 'Copié !';
      showToast('Code copié dans le presse-papier !');
      setTimeout(() => {
        UI.copyBtnText.textContent = 'Copier le code';
      }, 2000);
    } catch (_) {
      showToast(`Code : ${rawPairingCode}`);
    }
  });
}

// --- Bouton Annuler le pairing ---
if (UI.btnCancelPairing) {
  UI.btnCancelPairing.addEventListener('click', () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    currentPhonePending = null;
    rawPairingCode = '';
    showView('pairing');
  });
}

// --- SSE Real-time Events ---
if (window.EventSource) {
  const evtSource = new EventSource('/api/events');

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'session_qr' && data.qr && activeQrSessionId) {
        if (UI.qrImage) UI.qrImage.src = data.qr;
      }

      if (data.type === 'session_update') {
        // Validation via code
        if (data.status === 'connected' && currentPhonePending && data.phone && data.phone.includes(currentPhonePending)) {
          onPhoneConnectedSuccess(currentPhonePending);
        }
        // Validation via QR
        if (data.status === 'connected' && activeQrSessionId) {
          const ph = data.phone ? data.phone.replace(/[^0-9]/g, '') : (data.user?.phone || '');
          onPhoneConnectedSuccess(ph);
        }
      }
    } catch (_) {}
  };
}