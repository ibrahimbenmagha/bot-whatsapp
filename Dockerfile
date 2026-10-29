# Utiliser l'image officielle Node.js 20 LTS
FROM node:20-slim

# Définir le répertoire de travail
WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances de production
RUN npm install --omit=dev

# Copier le reste du projet
COPY . .

# Créer les dossiers de persistance
RUN mkdir -p auth_info_multi logs

# Variables d'environnement par défaut
ENV NODE_ENV=production

# Commande de démarrage
CMD ["node", "index.js"]
