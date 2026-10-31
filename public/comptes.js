// Gestionnaire de la page des comptes connectés

const UI = {
  accountsContainer: document.getElementById('accountsContainer'),
  navAccountsCount: document.getElementById('navAccountsCount'),
  activityLogs: document.getElementById('activityLogs'),
  toast: document.getElementById('toast'),
};

function showToast(msg) {
  if (!UI.toast) return;
  UI.toast.textContent = msg;
  UI.toast.hidden = false;
  setTimeout(() => { UI.toast.hidden = true; }, 3000);
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

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Erreur lors du chargement');

    const accounts = data.accounts || [];
    renderAccounts(accounts);
  } catch (err) {
    UI.accountsContainer.innerHTML = `<div class="groups-empty" style="color:#ef4444;">❌ Erreur: ${err.message}</div>`;
  }
}

function renderAccounts(accounts) {
  const connectedCount = accounts.filter(a => a.status === 'connected').length;
  if (UI.navAccountsCount) {
    UI.navAccountsCount.textContent = connectedCount;
  }

  if (accounts.length === 0) {
    UI.accountsContainer.innerHTML = `
      <div class="empty-accounts">
        <div class="empty-icon">📱</div>
        <h3>Aucun compte WhatsApp connecté</h3>
        <p>Vous n'avez pas encore de bot WhatsApp actif. Liez votre premier compte facilement par code.</p>
        <a href="index.html" class="btn btn-primary" style="display:inline-flex; text-decoration:none;">
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

    const connectedTime = acc.connectedAt ? new Date(acc.connectedAt).toLocaleTimeString() : 'Récemment';

    html += `
      <div class="account-card" id="account-${acc.phone.replace(/[^0-9]/g, '')}">
        <div class="account-card-left">
          <div class="account-avatar">📱</div>
          <div class="account-meta">
            <span class="account-phone-title">${acc.phone}</span>
            <span class="account-name-sub">${acc.name || 'Bot WhatsApp'} • Activé à ${connectedTime}</span>
            <div class="account-badges">
              ${statusBadge}
              <span class="badge-groups-count">🏰 ${acc.groupsCount || 0} groupe(s)</span>
            </div>
          </div>
        </div>
        <div class="account-card-right">
          <button type="button" class="btn btn-sm btn-danger" onclick="disconnectAccount('${acc.phone}')">
            <span>🗑️ Déconnecter</span>
          </button>
        </div>
      </div>
    `;
  }

  UI.accountsContainer.innerHTML = html;
}

window.disconnectAccount = async function(phoneNumber) {
  const clean = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!confirm(`Êtes-vous sûr de vouloir déconnecter le compte +${clean} ?\nLes autres comptes connectés resteront actifs.`)) {
    return;
  }

  try {
    const res = await fetch('/api/accounts/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: clean })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast(`Compte +${clean} déconnecté avec succès.`);
    await loadAccounts();
  } catch (err) {
    alert(`Erreur: ${err.message}`);
  }
};

// Initialisation et SSE
loadAccounts();
setInterval(loadAccounts, 10000);

if (window.EventSource) {
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'log') {
        addLog(data.message, data.logType);
      }
      if (data.type === 'session_update' || data.type === 'session_deleted') {
        loadAccounts();
      }
    } catch (_) {}
  };
}
