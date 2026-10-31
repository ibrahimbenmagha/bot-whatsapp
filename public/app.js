// WhatsApp Bot Web Linker - Frontend Client

const UI = {
  // Cards
  cardPairing: document.getElementById('cardPairing'),
  cardCode: document.getElementById('cardCode'),
  cardConnected: document.getElementById('cardConnected'),

  // Header status
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),

  // Banner for current account
  currentAccountBanner: document.getElementById('currentAccountBanner'),
  bannerPhone: document.getElementById('bannerPhone'),
  bannerStatus: document.getElementById('bannerStatus'),
  btnQuickDisconnect: document.getElementById('btnQuickDisconnect'),

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

  // Connected Card
  connectedPhone: document.getElementById('connectedPhone'),
  connectedName: document.getElementById('connectedName'),
  connectedGroup: document.getElementById('connectedGroup'),
  groupsList: document.getElementById('groupsList'),
  groupsCountBadge: document.getElementById('groupsCountBadge'),
  activityLogs: document.getElementById('activityLogs'),
  btnSwitchAccount: document.getElementById('btnSwitchAccount'),
  btnDisconnect: document.getElementById('btnDisconnect'),

  // Toast
  toast: document.getElementById('toast'),
};

let currentStatus = 'disconnected';
let pollingTimer = null;
let rawPairingCode = '';

// --- Navigation between views ---
function showView(viewName) {
  UI.cardPairing.classList.remove('active');
  UI.cardCode.classList.remove('active');
  UI.cardConnected.classList.remove('active');

  if (viewName === 'pairing') {
    UI.cardPairing.classList.add('active');
  } else if (viewName === 'code') {
    UI.cardCode.classList.add('active');
  } else if (viewName === 'connected') {
    UI.cardConnected.classList.add('active');
  }
}

// --- Status Badge Helper ---
function updateStatusBadge(status, customText) {
  UI.statusBadge.className = 'status-badge';

  if (status === 'connected') {
    UI.statusBadge.classList.add('status-connected');
    UI.statusText.textContent = customText || 'En ligne';
  } else if (status === 'connecting' || status === 'awaiting_code') {
    UI.statusBadge.classList.add('status-connecting');
    UI.statusText.textContent = customText || (status === 'awaiting_code' ? 'Code en attente' : 'Connexion...');
  } else {
    UI.statusBadge.classList.add('status-disconnected');
    UI.statusText.textContent = customText || 'Non connecté';
  }
}

// --- Toast notification ---
function showToast(message) {
  UI.toast.textContent = message;
  UI.toast.hidden = false;
  setTimeout(() => {
    UI.toast.hidden = true;
  }, 3000);
}

// --- Show Alert ---
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

// --- Fetch Status ---
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Erreur de communication avec le serveur');
    const data = await res.json();

    currentStatus = data.status;

    // Mise à jour de la bannière de compte actuel
    if (data.user?.phone) {
      if (UI.currentAccountBanner) {
        UI.currentAccountBanner.hidden = false;
        UI.bannerPhone.textContent = data.user.phone + (data.user.name ? ` (${data.user.name})` : '');
        UI.bannerStatus.textContent = data.status === 'connected' ? '🟢 En ligne et actif' : '🔴 Déconnecté';
      }
    } else {
      if (UI.currentAccountBanner) {
        UI.currentAccountBanner.hidden = true;
      }
    }

    if (data.status === 'connected') {
      updateStatusBadge('connected', 'Connecté');
      showView('connected');
      UI.connectedPhone.textContent = data.user?.phone || (data.user?.id ? `+${data.user.id.split('@')[0].split(':')[0]}` : '+En ligne');
      UI.connectedName.textContent = data.user?.name || 'Bot WhatsApp';
      UI.connectedGroup.textContent = data.targetGroup || 'Tous les groupes';

      if (data.groups && Array.isArray(data.groups)) {
        renderGroups(data.groups);
      }

      if (data.logs && Array.isArray(data.logs)) {
        renderLogs(data.logs);
      }
    } else if (data.status === 'awaiting_code' && data.pairingCode) {
      updateStatusBadge('awaiting_code', 'Code prêt');
      rawPairingCode = data.pairingCode;
      UI.codeDisplay.textContent = formatPairingCode(data.pairingCode);
      showView('code');
    } else if (data.status === 'connecting') {
      updateStatusBadge('connecting', 'Connexion...');
    } else {
      updateStatusBadge('disconnected', 'Déconnecté');
      if (document.querySelector('.card.active') === UI.cardConnected) {
        showView('pairing');
      }
    }
  } catch (err) {
    console.error('Erreur checkStatus:', err);
  }
}

function renderLogs(logs) {
  UI.activityLogs.innerHTML = '';
  logs.forEach(log => {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = log;
    UI.activityLogs.appendChild(entry);
  });
  UI.activityLogs.scrollTop = UI.activityLogs.scrollHeight;
}

function renderGroups(groups) {
  if (!UI.groupsList) return;
  if (UI.groupsCountBadge) {
    UI.groupsCountBadge.textContent = groups.length;
  }
  if (!groups || groups.length === 0) {
    UI.groupsList.innerHTML = '<div class="groups-empty">Aucun groupe détecté. Ajoutez le bot à vos groupes WhatsApp !</div>';
    return;
  }

  UI.groupsList.innerHTML = '';
  groups.forEach((g) => {
    const item = document.createElement('div');
    item.className = 'group-item';
    const safeName = escapeHtml(g.name);
    item.innerHTML = `
      <div class="group-main">
        <span class="group-icon">👥</span>
        <span class="group-name">${safeName}</span>
      </div>
      <div class="group-meta">
        <span>${g.participantsCount} membres</span>
        ${g.isAdmin ? '<span class="group-admin-tag">👑 Admin</span>' : ''}
      </div>
    `;
    UI.groupsList.appendChild(item);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// --- Submit Phone Number for Pairing Code ---
UI.pairForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert();

  let phone = UI.phoneNumber.value.trim().replace(/[^0-9]/g, '');

  if (!phone || phone.length < 8) {
    showAlert('Veuillez entrer un numéro valide avec indicatif (ex: 33612345678).');
    return;
  }

  // Set loading state
  UI.btnGenerate.disabled = true;
  UI.btnSpinner.hidden = false;
  UI.btnLabel.textContent = 'Génération du code...';
  updateStatusBadge('connecting', 'Génération...');

  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone }),
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Impossible de générer le code d\'association.');
    }

    rawPairingCode = result.code;
    UI.codeDisplay.textContent = formatPairingCode(result.code);
    updateStatusBadge('awaiting_code', 'Code généré');
    showView('code');
    showToast('Code généré avec succès ! Saisissez-le sur WhatsApp');
  } catch (error) {
    console.error('Erreur pairing:', error);
    showAlert(error.message || 'Erreur lors de la demande du code.');
    updateStatusBadge('disconnected', 'Erreur');
  } finally {
    UI.btnGenerate.disabled = false;
    UI.btnSpinner.hidden = true;
    UI.btnLabel.textContent = 'Générer le code de liaison';
  }
});

// --- Copy Code to Clipboard ---
UI.btnCopyCode.addEventListener('click', async () => {
  const codeToCopy = rawPairingCode.replace(/[^a-zA-Z0-9]/g, '');
  if (!codeToCopy) return;

  try {
    await navigator.clipboard.writeText(codeToCopy);
    UI.copyBtnText.textContent = 'Copié !';
    showToast('Code copié dans le presse-papiers');
    setTimeout(() => {
      UI.copyBtnText.textContent = 'Copier le code';
    }, 2500);
  } catch (_) {
    // Fallback
    const input = document.createElement('input');
    input.value = codeToCopy;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('Code copié !');
  }
});

// --- Cancel Pairing / Change Number ---
UI.btnCancelPairing.addEventListener('click', async () => {
  if (confirm('Voulez-vous annuler et saisir un autre numéro ?')) {
    try {
      await fetch('/api/cancel-pairing', { method: 'POST' });
    } catch (_) {}
    rawPairingCode = '';
    showView('pairing');
    updateStatusBadge('disconnected', 'Non connecté');
  }
});

// --- Switch Account Button (From connected card) ---
if (UI.btnSwitchAccount) {
  UI.btnSwitchAccount.addEventListener('click', () => {
    showView('pairing');
    UI.phoneNumber.focus();
    showToast('Saisissez le nouveau numéro de téléphone à connecter');
  });
}

// --- Quick Disconnect Button (From banner) ---
if (UI.btnQuickDisconnect) {
  UI.btnQuickDisconnect.addEventListener('click', async () => {
    if (confirm('Voulez-vous vraiment déconnecter ce compte WhatsApp ?')) {
      try {
        const res = await fetch('/api/disconnect', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Compte déconnecté avec succès.');
          checkStatus();
        }
      } catch (err) {
        alert('Erreur: ' + err.message);
      }
    }
  });
}

// --- Disconnect Bot ---
UI.btnDisconnect.addEventListener('click', async () => {
  if (confirm('Voulez-vous vraiment déconnecter le bot WhatsApp ? La session sera supprimée.')) {
    try {
      const res = await fetch('/api/disconnect', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Bot déconnecté.');
        showView('pairing');
        updateStatusBadge('disconnected', 'Déconnecté');
      }
    } catch (err) {
      alert('Erreur lors de la déconnexion: ' + err.message);
    }
  }
});

// --- Realtime SSE or Polling ---
function startEventSource() {
  if (window.EventSource) {
    try {
      const es = new EventSource('/api/events');
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'status') {
            checkStatus();
          } else if (data.type === 'log') {
            addLogEntry(data.message, data.logType);
          }
        } catch (_) {}
      };
      es.onerror = () => {
        es.close();
        if (!pollingTimer) {
          pollingTimer = setInterval(checkStatus, 2500);
        }
      };
    } catch (_) {
      pollingTimer = setInterval(checkStatus, 2500);
    }
  } else {
    pollingTimer = setInterval(checkStatus, 2500);
  }
}

// Initialize
checkStatus();
startEventSource();
setInterval(checkStatus, 3000);
