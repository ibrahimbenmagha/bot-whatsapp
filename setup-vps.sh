#!/bin/bash
# ==============================================================
# Script d'installation automatique pour Oracle Cloud / VPS Linux
# Projet : Bot de Modération WhatsApp (Baileys + Express)
# Dépôt : https://github.com/ibrahimbenmagha/bot-whatsapp
# ==============================================================

set -e

echo "🚀 [1/5] Mise à jour du système..."
sudo apt update && sudo apt upgrade -y

echo "📦 [2/5] Installation des dépendances système (Git, Curl, Node.js 20 LTS)..."
sudo apt install -y curl git ufw build-essential

# Installer Node.js 20 LTS si pas déjà installé
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

echo "🟢 Version Node.js installée : $(node -v)"
echo "🟢 Version NPM installée     : $(npm -v)"

echo "⚙️ [3/5] Installation de PM2 (gestionnaire de processus 24/7)..."
sudo npm install -g pm2

# Configurer le pare-feu pour le port 3000 (interface Web de liaison)
echo "🛡️ [4/5] Configuration du pare-feu pour l'interface web (port 3000)..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 3000/tcp || true
    sudo ufw allow 22/tcp || true
fi

# Configuration de l'application
APP_DIR="$HOME/bot-whatsapp"

if [ -d "$APP_DIR" ]; then
    echo "🔄 Mise à jour du code existant dans $APP_DIR..."
    cd "$APP_DIR"
    git pull origin main
else
    echo "📥 Clonage du dépôt dans $APP_DIR..."
    git clone https://github.com/ibrahimbenmagha/bot-whatsapp.git "$APP_DIR"
    cd "$APP_DIR"
fi

echo "📦 Installation des dépendances NPM..."
npm install

# Créer .env si inexistant
if [ ! -f ".env" ]; then
    echo "⚙️ Création du fichier .env depuis .env.example..."
    cp .env.example .env
fi

# Création du dossier de logs
mkdir -p logs

echo "🚀 [5/5] Démarrage du bot avec PM2..."
pm2 delete bot-whatsapp 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

# Configuration du redémarrage automatique en cas de reboot du serveur
STARTUP_CMD=$(pm2 startup systemd -u $USER --hp $HOME | grep "sudo env")
if [ -n "$STARTUP_CMD" ]; then
    eval "$STARTUP_CMD" || true
    pm2 save
fi

echo ""
echo "=============================================================="
echo "✅ BOT DÉPLOYÉ AVEC SUCCÈS SUR LE SERVEUR !"
echo "=============================================================="
echo ""
echo "📱 PROCHAINE ÉTAPE : Lier votre compte WhatsApp"
echo "1. Ouvrez dans votre navigateur : http://$(curl -s ifconfig.me):3000"
echo "2. Tapez votre numéro de téléphone et demandez un code d'association."
echo "3. Sur votre téléphone : WhatsApp > Appareils connectés > Lier avec le numéro."
echo ""
echo "Commandes utiles :"
echo "  - Voir les logs en direct : pm2 logs bot-whatsapp"
echo "  - Statut du bot           : pm2 status"
echo "  - Redémarrer              : pm2 restart bot-whatsapp"
echo "=============================================================="

