# Utiliser l'image officielle Node.js 20 LTS
FROM node:20-slim

# Définir le répertoire de travail
WORKDIR /app

# Installer ffmpeg, python3 et yt-dlp pour les fonctionnalités multimédia (stickers et musiques)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip3 install yt-dlp --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances de production
RUN npm install --omit=dev

# Copier le reste du projet
COPY . .

# Créer les dossiers de persistance
RUN mkdir -p auth_info_multi logs temp_audio

# Variables d'environnement par défaut
ENV NODE_ENV=production

# Commande de démarrage
CMD ["node", "index.js"]
