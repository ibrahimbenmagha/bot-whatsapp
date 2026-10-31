// WhatsApp Bot Web Linker - Frontend Client Multi-Comptes

const UI = {
  // Cards
  cardPairing: document.getElementById('cardPairing'),
  cardCode: document.getElementById('cardCode'),

  // Header & Nav
  headerAccountsText: document.getElementById('headerAccountsText'),
  navAccountsCount: document.getElementById('navAccountsCount'),

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

  // Logs
  activityLogs: document.getElementById('activityLogs'),
  toast: document.getElementById('toast'),
};

let currentPhonePending = null;
let rawPairingCode = '';

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
  }, 3000);
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

// --- Add log entry ---
function addLogEntry(text, type = 'info') {
  if (!UI.activityLogs) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'system' ? 'log-system' : type === 'warn' ? 'log-warn' : ''}`;
  const now = new Date().toLocaleTimeString();
  entry.textContent = `[${now}] ${text}`;
  UI.activityLogs.appendChild(entry);
  UI.activityLogs.scrollTop = UI.activityLogs.scrollHeight;
}

// --- Mettre à jour les compteurs de comptes connectés ---
async function updateAccountsCount() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    if (data.success) {
      const connected = (data.accounts || []).filter(a => a.status === 'connected');
      if (UI.navAccountsCount) UI.navAccountsCount.textContent = connected.length;
      if (UI.headerAccountsText) {
        UI.headerAccountsText.textContent = `${connected.length} Compte(s) Connecté(s)`;
      }
    }
  } catch (_) {}
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
      showToast('Code généré avec succès !');
    } catch (err) {
      showAlert(err.message || 'Erreur inconnue.');
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

      if (data.type === 'log') {
        addLogEntry(data.message, data.logType);
      }

      if (data.type === 'session_update') {
        updateAccountsCount();

        // Si le compte actuellement en cours de saisie vient de se connecter
        if (data.status === 'connected' && currentPhonePending && data.phone.includes(currentPhonePending)) {
          showToast(`🎉 Le compte +${currentPhonePending} est maintenant connecté !`);
          if (UI.connectionSuccessNotice) {
            UI.connectionSuccessNotice.hidden = false;
            UI.successPhone.textContent = `+${currentPhonePending}`;
          }
          currentPhonePending = null;
          rawPairingCode = '';
          UI.phoneNumber.value = '';
          showView('pairing');
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
setInterval(updateAccountsCount, 8000);
