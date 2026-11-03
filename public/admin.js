// ============================================================================
// Panneau d'Administration - إمبراطورية باراديس
// Gestion de l'authentification et Déconnexion Forcée des numéros connectés
// ============================================================================

const TOKEN_KEY = 'paradis_admin_token';

const UI = {
  loginView: document.getElementById('loginView'),
  dashboardView: document.getElementById('dashboardView'),
  adminLoginForm: document.getElementById('adminLoginForm'),
  usernameInput: document.getElementById('usernameInput'),
  passwordInput: document.getElementById('passwordInput'),
  togglePasswordBtn: document.getElementById('togglePasswordBtn'),
  btnLoginSubmit: document.getElementById('btnLoginSubmit'),
  loginError: document.getElementById('loginError'),
  loginErrorText: document.getElementById('loginErrorText'),
  adminLoggedName: document.getElementById('adminLoggedName'),
  btnLogoutBtn: document.getElementById('btnLogoutBtn'),
  btnRefreshAccounts: document.getElementById('btnRefreshAccounts'),
  adminAccountsContainer: document.getElementById('adminAccountsContainer'),
  statConnectedCount: document.getElementById('statConnectedCount'),
  statGroupsCount: document.getElementById('statGroupsCount'),
  statBotMode: document.getElementById('statBotMode'),
  activityLogs: document.getElementById('activityLogs'),
  confirmModal: document.getElementById('confirmModal'),
  modalPhoneTarget: document.getElementById('modalPhoneTarget'),
  btnCancelModal: document.getElementById('btnCancelModal'),
  btnConfirmForceDisconnect: document.getElementById('btnConfirmForceDisconnect'),
  toast: document.getElementById('toast'),
};

let currentTargetPhoneToDisconnect = null;

function showToast(msg) {
  if (!UI.toast) return;
  UI.toast.textContent = msg;
  UI.toast.hidden = false;
  setTimeout(() => { UI.toast.hidden = true; }, 3500);
}

function addLog(text, type = 'info') {
  if (!UI.activityLogs) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'system' ? 'log-system' : type === 'warn' ? 'log-warn' : ''}`;
  const now = new Date().toLocaleTimeString();
  entry.textContent = `[${now}] ${text}`;
  UI.activityLogs.appendChild(entry);
  UI.activityLogs.scrollTop = UI.activityLogs.scrollHeight;
}

function getStoredToken() {
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
}

function setStoredToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_KEY, token);
}

function clearStoredToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

// ----------------------------------------------------
// Gestion de l'affichage (Login vs Dashboard)
// ----------------------------------------------------

function showDashboardView(username) {
  UI.loginView.style.display = 'none';
  UI.dashboardView.style.display = 'block';
  if (UI.adminLoggedName && username) {
    UI.adminLoggedName.textContent = username;
  }
  loadAdminAccounts();
}

function showLoginView() {
  UI.dashboardView.style.display = 'none';
  UI.loginView.style.display = 'flex';
  if (UI.passwordInput) UI.passwordInput.value = '';
}

// ----------------------------------------------------
// Vérification de Session au Chargement
// ----------------------------------------------------

async function checkAuthSession() {
  const token = getStoredToken();
  if (!token) {
    showLoginView();
    return;
  }

  try {
    const res = await fetch('/api/admin/verify', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      showDashboardView(data.username);
    } else {
      clearStoredToken();
      showLoginView();
    }
  } catch (err) {
    showLoginView();
  }
}

// ----------------------------------------------------
// Formulaire de Connexion
// ----------------------------------------------------

if (UI.adminLoginForm) {
  UI.adminLoginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    UI.loginError.style.display = 'none';

    const username = UI.usernameInput.value.trim();
    const password = UI.passwordInput.value.trim();

    if (!username || !password) return;

    UI.btnLoginSubmit.disabled = true;
    UI.btnLoginSubmit.innerHTML = '<span>⏳ Vérification...</span>';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (data.success && data.token) {
        setStoredToken(data.token);
        showDashboardView(data.username);
        showToast(`Bienvenue, Maître ${data.username} 🏰`);
      } else {
        UI.loginErrorText.textContent = data.error || 'Identifiant ou mot de passe incorrect.';
        UI.loginError.style.display = 'flex';
      }
    } catch (err) {
      UI.loginErrorText.textContent = `Erreur réseau : ${err.message}`;
      UI.loginError.style.display = 'flex';
    } finally {
      UI.btnLoginSubmit.disabled = false;
      UI.btnLoginSubmit.innerHTML = '<span>🔒 Connexion à l\'espace Admin</span>';
    }
  });
}

// Bouton Masquer/Afficher mot de passe
if (UI.togglePasswordBtn && UI.passwordInput) {
  UI.togglePasswordBtn.addEventListener('click', () => {
    const isPassword = UI.passwordInput.type === 'password';
    UI.passwordInput.type = isPassword ? 'text' : 'password';
    UI.togglePasswordBtn.textContent = isPassword ? '🙈' : '👁️';
  });
}

// Déconnexion Admin
if (UI.btnLogoutBtn) {
  UI.btnLogoutBtn.addEventListener('click', async () => {
    const token = getStoredToken();
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (_) {}
    clearStoredToken();
    showLoginView();
    showToast('Vous avez été déconnecté.');
  });
}

// Bouton Actualiser
if (UI.btnRefreshAccounts) {
  UI.btnRefreshAccounts.addEventListener('click', () => {
    loadAdminAccounts();
    showToast('Liste des comptes actualisée.');
  });
}

// ----------------------------------------------------
// Chargement et Affichage des Comptes
// ----------------------------------------------------

async function loadAdminAccounts() {
  const token = getStoredToken();
  if (!token) return;

  try {
    const res = await fetch('/api/admin/accounts', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (!data.success) {
      if (res.status === 401) {
        clearStoredToken();
        showLoginView();
        return;
      }
      throw new Error(data.error || 'Erreur lors du chargement');
    }

    const accounts = data.accounts || [];
    renderAdminAccounts(accounts);
  } catch (err) {
    if (UI.adminAccountsContainer) {
      UI.adminAccountsContainer.innerHTML = `<div class="groups-empty" style="color:#ef4444;">❌ Erreur: ${err.message}</div>`;
    }
  }
}

function renderAdminAccounts(accounts) {
  const connectedAccounts = accounts.filter(a => a.status === 'connected');
  
  if (UI.statConnectedCount) {
    UI.statConnectedCount.textContent = connectedAccounts.length;
  }

  // Calcul du total de groupes
  let totalGroups = 0;
  for (const acc of accounts) {
    totalGroups += (acc.groupsCount || 0);
  }
  if (UI.statGroupsCount) {
    UI.statGroupsCount.textContent = totalGroups;
  }

  if (accounts.length === 0) {
    UI.adminAccountsContainer.innerHTML = `
      <div class="empty-accounts" style="padding: 40px 20px; text-align: center;">
        <div class="empty-icon" style="font-size: 48px; margin-bottom: 12px;">📱</div>
        <h3 style="color: #fff; font-size: 18px; margin-bottom: 8px;">Aucun compte WhatsApp connecté</h3>
        <p style="color: #94a3b8; font-size: 14px; max-width: 400px; margin: 0 auto 20px;">Le bot n'a actuellement aucun numéro WhatsApp actif. Vous pouvez lier un compte via la page d'accueil.</p>
        <a href="/" target="_blank" class="btn btn-primary" style="display:inline-flex; text-decoration:none;">
          <span>⚡ Lier un compte WhatsApp</span>
        </a>
      </div>
    `;
    return;
  }

  let html = '';
  for (const acc of accounts) {
    const isOnline = acc.status === 'connected';
    const statusBadge = isOnline
      ? `<span class="badge-online">🟢 En ligne</span>`
      : `<span class="badge-groups-count" style="color:#f59e0b;">⏳ Connexion...</span>`;

    const connectedTime = acc.connectedAt ? new Date(acc.connectedAt).toLocaleTimeString() : 'Actif';
    const cleanNum = String(acc.phone || '').replace(/[^0-9]/g, '');

    html += `
      <div class="account-card" id="account-${cleanNum}">
        <div class="account-card-left">
          <div class="account-avatar">📱</div>
          <div class="account-meta">
            <span class="account-phone-title">+${cleanNum}</span>
            <span class="account-name-sub">${acc.name || 'Bot WhatsApp'} • Connecté à ${connectedTime}</span>
            <div class="account-badges">
              ${statusBadge}
              <span class="badge-groups-count">🏰 ${acc.groupsCount || 0} groupe(s)</span>
            </div>
          </div>
        </div>
        <div class="account-card-right">
          <button type="button" class="btn-force-disconnect" onclick="promptForceDisconnect('${cleanNum}')">
            <span>⛔ Forcer la déconnexion</span>
          </button>
        </div>
      </div>
    `;
  }

  UI.adminAccountsContainer.innerHTML = html;
}

// ----------------------------------------------------
// Modal et Déconnexion Forcée
// ----------------------------------------------------

window.promptForceDisconnect = function(cleanPhone) {
  currentTargetPhoneToDisconnect = cleanPhone;
  if (UI.modalPhoneTarget) {
    UI.modalPhoneTarget.textContent = `+${cleanPhone}`;
  }
  if (UI.confirmModal) {
    UI.confirmModal.style.display = 'flex';
  }
};

function closeConfirmModal() {
  currentTargetPhoneToDisconnect = null;
  if (UI.confirmModal) {
    UI.confirmModal.style.display = 'none';
  }
}

if (UI.btnCancelModal) {
  UI.btnCancelModal.addEventListener('click', closeConfirmModal);
}

if (UI.confirmModal) {
  UI.confirmModal.addEventListener('click', (e) => {
    if (e.target === UI.confirmModal) closeConfirmModal();
  });
}

if (UI.btnConfirmForceDisconnect) {
  UI.btnConfirmForceDisconnect.addEventListener('click', async () => {
    if (!currentTargetPhoneToDisconnect) return;

    const phoneToKill = currentTargetPhoneToDisconnect;
    const token = getStoredToken();

    UI.btnConfirmForceDisconnect.disabled = true;
    UI.btnConfirmForceDisconnect.innerHTML = '<span>⏳ Déconnexion forcée en cours...</span>';

    try {
      const res = await fetch('/api/admin/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ phoneNumber: phoneToKill })
      });

      const data = await res.json();

      if (data.success) {
        showToast(`Compte +${phoneToKill} déconnecté de force avec succès !`);
        addLog(`[ADMIN] Déconnexion forcée du compte +${phoneToKill} confirmée.`, 'warn');
        closeConfirmModal();
        await loadAdminAccounts();
      } else {
        alert(`Échec de la déconnexion : ${data.error}`);
      }
    } catch (err) {
      alert(`Erreur réseau : ${err.message}`);
    } finally {
      UI.btnConfirmForceDisconnect.disabled = false;
      UI.btnConfirmForceDisconnect.innerHTML = '<span>⛔ Oui, forcer la déconnexion</span>';
    }
  });
}

// ----------------------------------------------------
// Initialisation & Événements en Direct (SSE)
// ----------------------------------------------------

checkAuthSession();

// Recharger les données toutes les 15 secondes si connecté
setInterval(() => {
  if (getStoredToken() && UI.dashboardView.style.display === 'block') {
    loadAdminAccounts();
  }
}, 15000);

if (window.EventSource) {
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'log') {
        addLog(data.message, data.logType);
      }
      if (data.type === 'session_update' || data.type === 'session_deleted') {
        if (getStoredToken() && UI.dashboardView.style.display === 'block') {
          loadAdminAccounts();
        }
      }
    } catch (_) {}
  };
}

