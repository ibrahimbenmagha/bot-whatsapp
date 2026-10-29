# 🚀 Guide Complet de Déploiement du Bot WhatsApp sur Serveur Externe

Ce guide vous explique pas à pas comment faire tourner votre bot WhatsApp sur un **serveur distant 24h/24** et le relier au compte WhatsApp de **votre téléphone portable** (autre appareil).

---

## 📌 Principe de Fonctionnement

- Le bot utilise **Baileys (protocole WhatsApp Multi-Appareils)**.
- Il se connecte comme une session **WhatsApp Web / Appareil lié**. Votre téléphone reste le compte principal.
- **Une fois l'appareil associé la 1ère fois**, les clés de session sont sauvegardées dans le dossier `auth_info_multi/`. Le bot restera connecté en continu sans jamais redemander de scan, même en cas de redémarrage.

---

## ⚙️ Configuration du fichier `.env`

Avant de démarrer, configurez le fichier `.env` sur le serveur :

```bash
cp .env.example .env
nano .env
```

Remplissez les paramètres :

```ini
# Nom du groupe à modérer
TARGET_GROUP_NAME=Nom de votre groupe

# Avertissements max avant exclusion
MAX_WARNINGS=3

# Méthode d'authentification : "code" (recommandé pour serveur) ou "qr"
AUTH_METHOD=code

# Votre numéro de téléphone avec l'indicatif international (sans +, sans espaces)
# Exemple France: 33612345678 | Maroc: 212612345678 | Algérie: 213551234567
PHONE_NUMBER=33612345678
```

---

## 📱 Comment relier votre téléphone au bot

### Option A : Par Code d'association (Recommandé sur serveur distant) ⭐
1. Démarrez le bot : `npm start`
2. Le terminal affiche un encadré avec un code à 8 caractères :
   ```text
   ╔════════════════════════════════════════════════════════════════╗
   ║               📱 CODE D'ASSOCIATION WHATSAPP                   ║
   ╠════════════════════════════════════════════════════════════════╣
   ║                  👉   ABCD-1234   👈                        ║
   ╚════════════════════════════════════════════════════════════════╝
   ```
3. Sur votre téléphone :
   - Ouvrez **WhatsApp**
   - Allez dans **Paramètres** (ou les 3 points) > **Appareils connectés**
   - Appuyez sur **Lier un appareil**
   - Choisissez en bas : **"Lier avec le numéro de téléphone"**
   - Saisissez le code `ABCD-1234`
4. C'est fait ! La session est enregistrée.

### Option B : Par QR Code classique
1. Mettez `AUTH_METHOD=qr` dans `.env`.
2. Démarrez le bot : `npm start`.
3. Scannez le QR Code qui s'affiche dans votre terminal avec l'appareil photo WhatsApp (*Appareils connectés > Lier un appareil*).

---

## 🖥️ Méthode 1 : Déploiement sur un VPS Linux (Ubuntu / Debian) - La plus stable

Idéal sur des hébergeurs comme **Hetzner**, **OVH**, **DigitalOcean**, **Scaleway**, ou **Oracle Cloud (gratuit)**.

### 1. Préparer le serveur (Connexion SSH)
Connectez-vous à votre VPS :
```bash
ssh root@IP_DE_VOTRE_SERVEUR
```

Installez **Node.js 20 LTS**, **Git** et **PM2** :
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
sudo npm install -g pm2
```

### 2. Récupérer le code sur le serveur
```bash
git clone https://github.com/votre-compte/BotWhatsapp.git
cd BotWhatsapp
npm install
```

### 3. Première liaison avec votre téléphone
Configurez le `.env` puis lancez le bot en direct pour faire la liaison :
```bash
npm start
```
Entrez votre numéro et associez le code sur votre téléphone. Une fois que vous voyez :
```text
✅ ✅ ✅ BOT CONNECTÉ AVEC SUCCÈS! ✅ ✅ ✅
```
Appuyez sur `Ctrl + C` pour arrêter la console interactive. La session est désormais enregistrée !

### 4. Lancer le bot 24h/24 en tâche de fond avec PM2
```bash
# Lancement via la configuration ecosystem
pm2 start ecosystem.config.cjs

# Activer le redémarrage automatique en cas de reboot du serveur
pm2 startup
pm2 save
```

### 5. Commandes de gestion PM2
- **Voir les logs en direct :** `pm2 logs bot-whatsapp`
- **Voir le statut du bot :** `pm2 status`
- **Redémarrer le bot :** `pm2 restart bot-whatsapp`
- **Arrêter le bot :** `pm2 stop bot-whatsapp`

---

## 🐳 Méthode 2 : Déploiement avec Docker

Si vous préférez utiliser des conteneurs Docker :

1. Construire et lancer le conteneur en arrière-plan :
   ```bash
   docker compose up -d
   ```
2. Consulter les logs pour récupérer le code d'association :
   ```bash
   docker compose logs -f
   ```
3. Les volumes suivants sont automatiquement conservés sur votre serveur :
   - `./auth_info_multi` (Session WhatsApp)
   - `./botdata.db` (Base de données des avertissements)
   - `./logs` (Journaux d'activité)

---

## ☁️ Méthode 3 : Déploiement sur Railway.app

1. Créez un compte sur [Railway.app](https://railway.app).
2. Liez votre dépôt GitHub contenant le projet.
3. **IMPORTANT :** Ajoutez un **Volume persistant** monté sur `/app/auth_info_multi` pour que votre bot ne perde pas sa connexion à chaque redémarrage.
4. Renseignez les variables d'environnement dans l'onglet *Variables* (`PHONE_NUMBER`, `AUTH_METHOD=code`, `TARGET_GROUP_NAME`).

---

## ❓ FAQ & Dépannage

### 1. Comment changer le numéro ou reconnecter un nouveau téléphone ?
Supprimez simplement le dossier de session et redémarrez :
```bash
rm -rf auth_info_multi
npm start
```

### 2. Le bot peut-il modérer plusieurs groupes ?
Oui, si vous mettez `TARGET_GROUP_NAME=*`, le bot surveillera tous les groupes dans lesquels il est administrateur.

### 3. Le bot doit-il être administrateur du groupe ?
**Oui.** Pour supprimer les messages contenant des liens interdits ou expulser des membres après 3 avertissements, le compte lié au bot doit obligatoirement avoir les droits d'administrateur dans le groupe WhatsApp.
