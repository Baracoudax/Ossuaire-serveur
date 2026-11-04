# Serveur Ossuaire

Il s'occupe de quatre choses :

- **les comptes** : pseudo + mot de passe (le mot de passe est haché avec scrypt, jamais stocké en clair) ;
- **la sauvegarde** : progression, statistiques, historique et réglages de chaque joueur ;
- **le rang classé** : calculé par le serveur à la fin de chaque partie classée, et le classement en ligne (survie, VS, classé par saison) ;
- **la mise en relation** : la liste des parties publiques et un serveur PeerJS (`/peer`). Les parties se jouent ensuite directement entre les navigateurs.

## Mise en ligne sur Render (gratuit)

### 1. La base de données : Neon

Les bases gratuites de Render sont effacées au bout de 30 jours. On prend donc Neon, gratuit et sans limite de durée.

1. Créez un compte sur https://neon.tech, puis un projet (région Europe, Francfort par exemple).
2. Dans *Connection details*, copiez l'adresse qui commence par `postgresql://…` (option *Pooled connection*).

La table se crée toute seule au premier démarrage.

### 2. Le code sur GitHub

1. Créez un dépôt GitHub (privé si vous voulez), par exemple `ossuaire-serveur`.
2. Mettez-y le contenu de ce dossier : `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `.gitignore`.
   Le plus simple est le bouton *Add file → Upload files* sur la page du dépôt.

### 3. Le service sur Render

1. Créez un compte sur https://render.com, puis *New → Blueprint* et choisissez le dépôt. Render lit `render.yaml`.
2. Il demande la valeur de `DATABASE_URL` : collez l'adresse Neon. Le secret des sessions (`SECRET`) est généré tout seul.
3. Une fois le déploiement terminé, vérifiez que l'adresse du service répond. Elle ressemble à `https://ossuaire.onrender.com`, et `https://ossuaire.onrender.com/api/ping` doit renvoyer `{"ok":1,…}`.

### 4. Brancher le jeu

Dans le `config.js` du jeu (à la racine du zip envoyé sur itch.io ou ailleurs), ajoutez :

```js
window.OSS_SERVER='https://ossuaire.onrender.com';
```

Vous pouvez aussi le faire au moment de fabriquer les zips :

```
OSS_SERVER=https://ossuaire.onrender.com python3 outils/build_dist.py
```

Le jeu affiche alors la section **Compte** dans Profil, le classement du serveur et la liste des parties publiques. Il passe aussi par ce serveur pour la mise en relation.

### 5. Les relais réseau (indispensable pour jouer entre réseaux différents)

Deux joueurs sur des réseaux différents (box, 4G, Wi-Fi d'entreprise) ne peuvent souvent pas se relier directement. Il leur faut un relais **TURN**.

1. Créez un compte gratuit sur https://www.metered.ca, puis ouvrez **TURN Server** dans le tableau de bord.
2. Notez le **nom de l'application** : c'est ce qui précède `.metered.live` dans l'adresse affichée, par exemple `ossuaire`.
3. Créez une clé dans **Credentials / API Key** et copiez-la.
4. Sur Render, ouvrez le service puis **Environment** et ajoutez deux variables :
   - `METERED_APP` : le nom de l'application ;
   - `METERED_KEY` : la clé.

   Enregistrez : le service redémarre tout seul.
5. Vérifiez sur `https://…onrender.com/api/ice` : la réponse doit contenir `"turn":true`.

Le jeu demande ces relais au serveur avant chaque connexion. Il n'y a rien à changer dans les zips du jeu.

L'offre gratuite de Metered couvre quelques Go de relais par mois. Seules les parties qui ne peuvent pas se relier directement passent par le relais.

Autre possibilité : n'importe quel serveur TURN, avec les variables `TURN_URLS` (adresses séparées par des virgules), `TURN_USER` et `TURN_PASS`.

## Bon à savoir

- **Mise en veille.** Le service gratuit s'endort après 15 minutes sans visite. Le premier joueur qui arrive attend jusqu'à une minute (le jeu affiche « Réveil du serveur… »). Pour l'éviter : un service de ping gratuit (UptimeRobot, toutes les 10 minutes sur `/api/ping`) ou l'offre payante de Render.
- **Changer le secret.** Si vous changez `SECRET`, tout le monde est déconnecté. Les comptes, eux, restent.
- **Mot de passe oublié.** Il n'y a pas d'adresse e-mail, donc pas de récupération automatique. Pour remettre un compte à zéro, supprimez sa ligne dans la table `joueurs` depuis la console SQL de Neon.
- **Limites.** Nombre d'essais de connexion limité par adresse et par pseudo. Au plus un résultat classé par minute et par compte. Écart éliminations-morts plafonné. Au plus 256 Ko de sauvegarde par joueur.
- **Essai sur votre ordinateur.** Lancez `npm install` puis `node server.js` (port 8080). Sans `DATABASE_URL`, les comptes sont rangés dans `donnees.json`.

## Adresses du serveur

| Adresse | Rôle |
|---|---|
| `GET /api/ping` | état |
| `POST /api/register`, `POST /api/login` | `{name, pass}` → jeton de session (90 jours) |
| `GET /api/me`, `PUT /api/me/data`, `POST /api/me/pass` | profil, sauvegarde, changement de mot de passe |
| `POST /api/rank` | fin de partie classée `{won, draw, perf}` → nouveau rang |
| `POST /api/score`, `GET /api/lb?t=s\|v\|r` | scores et classements |
| `GET/POST /api/games` | parties publiques |
| `GET /api/ice` | relais réseau (STUN/TURN) pour les connexions entre joueurs |
| `/peer` | mise en relation PeerJS |
