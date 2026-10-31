// WhatsApp Bot Web Linker - Frontend Client

const UI = {
  // Cards
  cardPairing: document.getElementById('cardPairing'),
  cardCode: document.getElementById('cardCode'),

  // Header
  headerAccountsCount: document.getElementById('headerAccountsCount'),

  // Success Notice
  connectionSuccessNotice: document.getElementById('connectionSuccessNotice'),
  successPhone: document.getElementById('successPhone'),

  // Form & inputs
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

  toast: document.getElementById('toast'),
};

let currentPhonePending = null;
let rawPairingCode = '';
let pollTimer = null;

// --- Navigation between views ---
function showView(viewName) {
  if (viewName === 'pairing') {
    UI.cardPairing.classList.add('active');
    UI.cardCode.classList.remove('active');
  } else if (viewName === 'code') {
    UI.cardPairing.classList.remove('active');
    UI.cardCode.classList.add('active');
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

// --- Alerts ---
function showAlert(message) {
  UI.alertMsg.textContent = message;
  UI.alertBox.hidden = false;
}
function hideAlert() {
  UI.alertBox.hidden = true;
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

// --- Mise à jour du compteur de comptes connectés ---
async function updateAccountsCount() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    if (data.success) {
      const accounts = data.accounts || [];
      const connected = accounts.filter(a => a.status === 'connected');
      if (UI.headerAccountsCount) {
        UI.headerAccountsCount.textContent = connected.length;
      }

      // Si un numéro était en cours d'appairage et est maintenant connecté
      if (currentPhonePending) {
        const isNowConnected = accounts.some(
          a => a.phone.includes(currentPhonePending) && a.status === 'connected'
        );

        if (isNowConnected) {
          onPhoneConnectedSuccess(currentPhonePending);
        }
      }
    }
  } catch (_) {}
}

// --- Quand un numéro s'est connecté avec succès ---
function onPhoneConnectedSuccess(phone) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  showToast(`🎉 Le numéro +${phone} a été connecté avec succès !`);

  if (UI.connectionSuccessNotice) {
    UI.connectionSuccessNotice.hidden = false;
    UI.successPhone.textContent = `+${phone}`;
  }

  // Réinitialiser le formulaire pour pouvoir entrer directement le numéro suivant
  currentPhonePending = null;
  rawPairingCode = '';
  if (UI.phoneNumber) {
    UI.phoneNumber.value = '';
    UI.phoneNumber.focus();
  }

  // Retour automatique vers la page du formulaire
  showView('pairing');
}

// --- Gestion de la soumission du formulaire ---
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
      pollTimer = setInterval(updateAccountsCount, 2000);
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

      if (data.type === 'session_update') {
        updateAccountsCount();

        if (data.status === 'connected' && currentPhonePending && data.phone && data.phone.includes(currentPhonePending)) {
          onPhoneConnectedSuccess(currentPhonePending);
        }
      }

      if (data.type === 'session_deleted') {
        updateAccountsCount();
      }
    } catch (_) {}
  };
}

// Initialisation
updateAccountsCount();
setInterval(updateAccountsCount, 10000);
