# Bifrost : guide d'installation et de connexion

Ce guide explique, pas à pas, comment :

1. [préparer le paquet](#2-préparer-le-paquet-à-distribuer) à installer sur les postes ;
2. [installer le serveur](#3-installer-le-serveur) (le « relais ») ;
3. [installer Bifrost sur un poste utilisateur](#4-installer-bifrost-sur-un-poste-windows) ;
4. [se connecter à un ordinateur](#5-procédure-de-connexion) ;
5. [dépanner](#7-dépannage) et [mettre à jour](#8-maintenance).

Pour le fonctionnement interne, le protocole et la sécurité, voir le [README](README.md).

---

## 1. Comprendre les trois pièces

```
 PC à contrôler                     Serveur Bifrost                   PC contrôleur
┌────────────────┐   wss://      ┌───────────────────┐   wss://    ┌──────────────────┐
│ application    │──────────────▶│ annuaire d'ID     │◀────────────│ application      │
│ Bifrost        │               │ + relais chiffré  │             │ Bifrost, ou      │
│ (Windows)      │◀──────────────│ (Node.js)         │────────────▶│ navigateur web   │
└────────────────┘               └───────────────────┘             └──────────────────┘
```

| Pièce | Rôle | Où ça tourne |
|---|---|---|
| **Serveur** | Met en relation deux ordinateurs à partir d'un identifiant à 9 chiffres et fait passer les données chiffrées. Il ne voit jamais l'écran, ni les mots de passe. | Un serveur Linux (recommandé), ou Windows, joignable depuis Internet en HTTPS. |
| **Poste contrôlé** | Partage son écran, reçoit clavier et souris. Il s'identifie par un numéro à 9 chiffres. | Windows 10/11 64 bits. |
| **Poste contrôleur** | Affiche l'écran distant et envoie clavier et souris. | Windows (application Bifrost) **ou** n'importe quel navigateur récent (Chrome, Edge, Firefox, Safari) via l'adresse du serveur. |

Ce qu'il faut retenir :

- **Aucun port à ouvrir sur les postes utilisateurs.** Ils se connectent *vers* le serveur (sortant, port 443).
- **Le serveur est la seule pièce à exposer sur Internet.** Il lui faut une adresse (nom de domaine) et un certificat HTTPS.
- **Le chiffrement est de bout en bout** : le serveur ne peut pas lire ce qui transite.

### Quelle installation choisir ?

| Situation | Serveur | Postes |
|---|---|---|
| **Test rapide chez vous**, deux PC sur le même réseau | Le relais intégré à l'application, sur l'un des deux PC ([§3.1](#31-test-en-réseau-local-sans-serveur-dédié)) | Application Windows des deux côtés |
| **Usage réel**, personnes hors de chez vous | Un petit serveur Linux avec nom de domaine et HTTPS ([§3.2](#32-serveur-linux-recommandé)) | Application Windows ; navigateur possible côté contrôleur |

---

## 2. Préparer le paquet à distribuer

Il n'existe pas encore de version précompilée : on construit le paquet une seule fois, sur **un PC Windows**, puis on copie le résultat sur les autres postes.

### 2.1 Prérequis de la machine de construction

- Windows 10/11 64 bits.
- **Node.js 20 ou plus récent** (testé avec Node 24) : <https://nodejs.org>, version « LTS ». Vérifiez dans PowerShell :
  ```powershell
  node --version      # v20.x ou plus
  npm --version
  ```
- Le dossier du projet Bifrost (celui qui contient `package.json`).
- Une connexion Internet (téléchargement d'Electron, environ 100 Mo, au premier `npm install`).

### 2.2 Construire

Dans PowerShell, **depuis le dossier du projet** :

```powershell
cd D:\Projets\bifrost          # adaptez le chemin
npm install                    # installe les dépendances (quelques minutes)
npm run dist                   # construit le paquet
```

Résultat : le dossier `dist\Bifrost-win32-x64\` (environ 370 Mo) contenant `Bifrost.exe`.

### 2.3 Vérifier avant de distribuer (facultatif mais conseillé)

```powershell
npm test                       # doit finir par « fail 0 »
```

### 2.4 Préparer la copie

Compressez le dossier **entier** `dist\Bifrost-win32-x64` en `.zip` (clic droit > « Compresser vers »). Ce `.zip` est ce que vous donnerez aux utilisateurs.

> **Ne séparez jamais `Bifrost.exe` du reste du dossier.** Les scripts PowerShell et l'assistant vidéo doivent rester à côté. Il n'y a pas d'installeur : c'est un dossier à copier.

---

## 3. Installer le serveur

### 3.1 Test en réseau local, sans serveur dédié

L'application Windows embarque un relais. C'est suffisant pour tester entre deux PC d'un même réseau, **pas** pour un usage depuis Internet.

Sur le PC qui jouera le rôle de serveur (il doit rester allumé pendant le test) :

1. Lancez `Bifrost.exe`.
2. Ouvrez **Paramètres** (en bas de la fenêtre).
3. Cochez **« Faire fonctionner le serveur sur cet ordinateur »**, laissez le port `7780`, cliquez sur **Appliquer**.
4. Une liste d'adresses apparaît, par exemple `ws://192.168.1.20:7780/ws` : c'est **l'adresse à donner aux autres postes**.
5. Si le pare-feu Windows affiche une demande d'autorisation, acceptez pour le réseau **privé**. Sans cela, le port 7780 est bloqué et les autres postes verront « Serveur injoignable ».

Ensuite, sur chaque autre poste, saisissez cette adresse dans *Paramètres > Serveur Bifrost* (voir [§4](#4-installer-bifrost-sur-un-poste-windows)).

> Sur ce mode, le trafic n'est pas protégé par TLS (`ws://`). Le contenu reste chiffré de bout en bout, mais n'utilisez ce mode que sur un réseau de confiance. Dans un navigateur, la page servie en `http://` (hors `localhost`) refusera de chiffrer : utilisez l'application.

### 3.2 Serveur Linux (recommandé)

Exemple complet sur **Debian 12 / Ubuntu 22.04 ou 24.04**. Il vous faut :

- un serveur (un petit VPS suffit : 1 vCPU, 512 Mo à 1 Go de RAM ; la bande passante dépend du nombre de sessions, environ 0,5 à 4 Mbit/s par session active en H.264, jusqu'à 20 Mbit/s si le navigateur retombe en JPEG) ;
- un **nom de domaine** que vous maîtrisez, par exemple `bifrost.exemple.fr` ;
- un accès `ssh` avec un utilisateur disposant de `sudo`.

#### Étape 1 : DNS

Chez votre registrar, créez un enregistrement **A** (et **AAAA** si vous avez de l'IPv6) :

```
bifrost.exemple.fr.   A   <adresse IP publique du serveur>
```

Attendez qu'il se propage (quelques minutes). Contrôle, depuis votre PC :

```powershell
nslookup bifrost.exemple.fr
```

#### Étape 2 : pare-feu

Seuls les ports **80** (obtention du certificat) et **443** (HTTPS) doivent être ouverts. Le port 7780 de Bifrost reste **interne**.

```bash
sudo apt update
sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

> Si votre hébergeur a son propre pare-feu (panneau web), ouvrez-y aussi 80 et 443.

#### Étape 3 : installer Node.js

```bash
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # v22.x
```

#### Étape 4 : créer un utilisateur dédié et le dossier

```bash
sudo useradd --system --home /opt/bifrost --shell /usr/sbin/nologin bifrost
sudo mkdir -p /opt/bifrost
sudo chown "$USER": /opt/bifrost
```

#### Étape 5 : copier les fichiers du serveur

Le serveur n'a besoin que de **quatre éléments** du projet : `server/`, `shared/`, `viewer/`, et les fichiers `package.json` / `package-lock.json`. Inutile de copier le reste.

Depuis **votre PC Windows**, dans PowerShell (adaptez l'utilisateur et le domaine) :

```powershell
cd D:\Projets\bifrost
scp -r server shared viewer package.json package-lock.json utilisateur@bifrost.exemple.fr:/opt/bifrost/
```

#### Étape 6 : installer la dépendance

Sur le serveur :

```bash
cd /opt/bifrost
npm ci --omit=dev          # installe uniquement « ws » (sans Electron)
sudo chown -R bifrost: /opt/bifrost
```

#### Étape 7 : essai à la main

```bash
sudo -u bifrost env HOST=127.0.0.1 PORT=7780 DATA_DIR=/tmp/bifrost-test node /opt/bifrost/server/index.js
```

Vous devez lire : `Bifrost server listening on http://127.0.0.1:7780`. Arrêtez avec `Ctrl+C`.

#### Étape 8 : le lancer comme service (démarrage automatique)

Créez le fichier `/etc/systemd/system/bifrost.service` :

```bash
sudo nano /etc/systemd/system/bifrost.service
```

Contenu :

```ini
[Unit]
Description=Bifrost relay server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bifrost
WorkingDirectory=/opt/bifrost
ExecStart=/usr/bin/node /opt/bifrost/server/index.js
Environment=HOST=127.0.0.1
Environment=PORT=7780
Environment=TRUST_PROXY=1
Environment=DATA_DIR=/var/lib/bifrost
StateDirectory=bifrost
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Activez-le :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bifrost
sudo systemctl status bifrost        # « active (running) »
journalctl -u bifrost -f             # journal en direct (Ctrl+C pour quitter)
```

Signification des variables :

| Variable | Valeur ici | Rôle |
|---|---|---|
| `HOST` | `127.0.0.1` | N'écoute que sur la machine : seul le proxy HTTPS y accède. |
| `PORT` | `7780` | Port interne. |
| `TRUST_PROXY` | `1` | Lit l'adresse réelle du client dans `X-Forwarded-For`. **À n'activer que derrière un proxy** (voir l'avertissement plus bas). |
| `DATA_DIR` | `/var/lib/bifrost` | Contient `ids.json`, l'annuaire des identifiants. À sauvegarder. |
| `TLS_CERT`, `TLS_KEY` | (non utilisées) | Chemins d'un certificat si le serveur doit faire lui-même le HTTPS, sans proxy. |

> **Avertissement `TRUST_PROXY`.** Si vous l'activez alors que le serveur est joignable *directement*, n'importe qui peut falsifier son adresse IP et contourner la limite de tentatives. Gardez toujours `HOST=127.0.0.1` avec `TRUST_PROXY=1`.

#### Étape 9 : le proxy HTTPS (Caddy, certificat automatique)

Caddy obtient et renouvelle seul le certificat Let's Encrypt.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Éditez `/etc/caddy/Caddyfile` (remplacez tout son contenu) :

```
bifrost.exemple.fr {
    reverse_proxy 127.0.0.1:7780
}
```

Puis :

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

Le WebSocket (`/ws`) passe sans réglage supplémentaire.

<details>
<summary>Variante nginx au lieu de Caddy</summary>

Avec `certbot` pour le certificat, dans le bloc `server { listen 443 ssl; … }` :

```nginx
location / {
    proxy_pass http://127.0.0.1:7780;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # pas $proxy_add_x_forwarded_for
    proxy_read_timeout 3600s;
}
```
</details>

#### Étape 10 : vérifier

Depuis votre PC :

```powershell
curl.exe -I https://bifrost.exemple.fr/
```

Attendu : `HTTP/2 200` (ou `HTTP/1.1 200`). Ouvrir `https://bifrost.exemple.fr` dans un navigateur doit afficher la page « Bifrost — Prise en main à distance ». Le serveur est prêt.

> **Adresse à donner aux postes :** `wss://bifrost.exemple.fr`

### 3.3 Serveur Windows (alternative)

Possible si vous n'avez pas de serveur Linux. Les principes sont identiques : Node.js, les mêmes quatre éléments du projet, un proxy HTTPS (Caddy existe pour Windows : <https://caddyserver.com/download>), et les ports 80 et 443 ouverts.

1. Installez Node.js (« LTS ») pour toute la machine.
2. Copiez `server\`, `shared\`, `viewer\`, `package.json`, `package-lock.json` dans `C:\Bifrost`.
3. Dans PowerShell, `cd C:\Bifrost` puis `npm ci --omit=dev`.
4. Créez `C:\Bifrost\start-server.cmd` :
   ```bat
   @echo off
   cd /d C:\Bifrost
   set HOST=127.0.0.1
   set PORT=7780
   set TRUST_PROXY=1
   set DATA_DIR=C:\Bifrost\data
   node server\index.js >> server.log 2>&1
   ```
5. Démarrage automatique (PowerShell **en administrateur**) :
   ```powershell
   schtasks /Create /TN "Bifrost serveur" /SC ONSTART /RU SYSTEM /TR "C:\Bifrost\start-server.cmd" /F
   schtasks /Run /TN "Bifrost serveur"
   ```
6. Installez Caddy avec le même `Caddyfile` qu'au §3.2 (étape 9) et ouvrez les ports 80 et 443 dans le pare-feu Windows.

---

## 4. Installer Bifrost sur un poste Windows

Valable pour le **poste contrôlé** comme pour le **poste contrôleur** : c'est le même programme.

### 4.1 Prérequis

- Windows 10 ou 11, **64 bits**.
- Aucun logiciel à installer : Windows 10/11 fournit déjà PowerShell 5.1 et le compilateur .NET que Bifrost utilise.
- Accès sortant vers le serveur (port 443 en HTTPS). Aucun port entrant.
- Environ 400 Mo d'espace disque.

### 4.2 Installation

1. Copiez le `.zip` préparé au [§2.4](#24-préparer-la-copie) sur le poste.
2. **Extrayez-le** (clic droit > « Extraire tout ») dans un dossier stable, par exemple `C:\Bifrost`.
   Évitez le dossier Téléchargements et ne lancez pas le programme depuis l'intérieur du zip.
3. Ouvrez le dossier extrait, puis double-cliquez sur **`Bifrost.exe`**.
4. **Avertissement SmartScreen** (« Windows a protégé votre ordinateur ») : le programme n'est pas signé. Cliquez sur **« Informations complémentaires »**, puis **« Exécuter quand même »**.
5. Au premier lancement, **patientez quelques secondes** : Bifrost compile son assistant de capture vidéo (une seule fois). Sans lui, il fonctionne quand même, en mode image plus lent.
6. Si le pare-feu Windows pose une question, vous pouvez **refuser** pour un poste normal : seul le mode « serveur sur cet ordinateur » a besoin d'accepter.

> Un antivirus peut ralentir ce premier lancement, voire bloquer l'assistant (programme non signé). Si l'écran distant reste très saccadé, ajoutez le dossier Bifrost aux exclusions.

### 4.3 Configuration (à faire une fois)

Dans la fenêtre Bifrost :

1. **Paramètres > Serveur Bifrost** : saisissez l'adresse du serveur, puis **Appliquer**.
   - Serveur Internet : `wss://bifrost.exemple.fr`
   - Test en réseau local : `ws://192.168.1.20:7780/ws` (adresse affichée au §3.1)
2. En haut à droite, le voyant doit passer à **« En ligne : joignable »**. Sinon, voir le [§7](#7-dépannage).
3. Dans **« Cet ordinateur »**, notez l'**identifiant à 9 chiffres** (bouton *Copier*). C'est ce qu'il faut donner à la personne qui se connectera.
4. *(Poste contrôlé, accès sans surveillance)* Dans **« Accès sans surveillance »**, définissez un **mot de passe de 12 caractères minimum**, long et unique, puis **Définir**.
   - Sans mot de passe : chaque connexion déclenche une fenêtre d'accord sur le poste, et personne ne peut se connecter si vous êtes absent.
   - Avec mot de passe : la personne qui le connaît entre directement. Cochez « Toujours demander mon accord… » si vous voulez malgré tout être sollicité.
5. Réglez ce que les personnes connectées peuvent faire en plus :
   - **Synchroniser le presse-papiers (texte)** : coché ou non.
   - **Transfert de fichiers** : *avec accord à chaque fichier* (par défaut), *sans demander*, ou *désactivé*.
   - **Dossiers partagés** : seuls ceux que vous ajoutez sont visibles, jamais le disque entier.
6. **Paramètres** : renseignez *Votre nom* (affiché à la personne que vous contrôlez).
   Cochez **« Démarrer Bifrost avec Windows »** et **« Rester dans la zone de notification… »** pour que le poste reste joignable. Fermer la fenêtre ne coupe alors pas l'accès : pour quitter vraiment, utilisez *Quitter Bifrost*.

### 4.4 Poste à joindre avant l'ouverture de session (option avancée : service Windows)

L'application tourne dans **votre** session Windows : elle ne voit ni l'écran de connexion, ni l'écran de verrouillage, ni les fenêtres UAC, et le PC n'est joignable que lorsqu'un utilisateur est connecté.

Pour un poste à joindre dès le démarrage (serveur, PC d'un proche à dépanner à distance), installez le **service Windows**. Il s'installe depuis le **dossier du projet** (pas depuis le paquet), avec Node.js :

1. Installez Node.js (« LTS ») et copiez le dossier du projet sur le poste (par exemple `C:\Bifrost-src`).
2. PowerShell **en administrateur** :
   ```powershell
   cd C:\Bifrost-src
   npm install --omit=dev
   node agent/agent.js set-password --service        # mot de passe de 12 caractères minimum : obligatoire
   node agent/agent.js service install --server wss://bifrost.exemple.fr
   node agent/agent.js service status                # doit indiquer RUNNING et un identifiant
   ```
3. Notez l'identifiant affiché. **Il est différent** de celui de l'application de bureau (le service a ses propres identifiant et mot de passe, dans `C:\ProgramData\Bifrost`).
4. Ne laissez pas tourner l'application de bureau et le service **en même temps** sur le même poste si vous voulez éviter la confusion : choisissez l'un ou l'autre pour ce poste.

Désinstallation : `node agent/agent.js service uninstall` (ajoutez `--purge` pour effacer aussi l'identifiant et le mot de passe).

> Avant de déployer le service sur des postes importants, suivez la liste « À vérifier chez vous après l'installation » du [README](README.md#à-vérifier-chez-vous-après-linstallation) (verrouillage Win+L, UAC, redémarrage) : ces points n'ont pas pu être testés automatiquement.

---

### 4.5 macOS et Linux

L'application de bureau fonctionne aussi sur macOS et Linux (voir le tableau du README). Construction : `npm install` puis `npm run dist` **sur la machine cible** (ou `npm run dist -- --platform=darwin --arch=arm64`) ; les paquets des releases GitHub suivent le même principe.

**macOS** (12 ou plus)
1. Au premier lancement, accordez à Bifrost **Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran** (pour être vu) et **Accessibilité** (pour être contrôlé), puis relancez l'application.
2. L'application n'est pas signée : clic droit → *Ouvrir*, ou `xattr -cr Bifrost.app`.
3. Un contrôleur Windows/Linux envoie **Ctrl** pour ses raccourcis : sur le Mac, Bifrost le traduit en **Commande** (Ctrl+C copie, Ctrl+V colle).

**Linux**
1. Une session **X11** (pas Wayland) et le paquet `xdotool` : `sudo apt install xdotool`. Sous Wayland l'écran peut être vu (portail PipeWire) mais la souris et le clavier ne peuvent pas être pilotés ; connectez-vous à une session « Xorg ».
2. Zone de notification : une extension d'icônes d'état est nécessaire sous GNOME.
3. Le démarrage automatique crée `~/.config/autostart/bifrost.desktop`.

Ces deux systèmes n'ont pas pu être essayés pendant le développement (voir le README) : signalez ce qui ne va pas.

## 5. Procédure de connexion

### 5.1 Rôles

- **Poste contrôlé** : l'ordinateur dont on voit l'écran. Bifrost doit y être lancé et « En ligne ».
- **Poste contrôleur** : l'ordinateur depuis lequel on agit.

### 5.2 Étapes

**Sur le poste contrôlé**

1. Vérifiez que Bifrost est lancé et que le voyant indique **« En ligne : joignable »**.
2. Communiquez à l'autre personne (téléphone, message) :
   - l'**identifiant à 9 chiffres** ;
   - si un mot de passe est défini, le **mot de passe**, par un canal différent de préférence.

**Sur le poste contrôleur** (deux façons au choix)

*Avec l'application Bifrost :*

1. Section **« Contrôler un autre ordinateur »**.
2. Saisissez l'**identifiant** (avec ou sans espaces).
3. Saisissez le **mot de passe** si vous l'avez, sinon laissez vide.
4. Choisissez :
   - **Prendre le contrôle** : voir l'écran, et utiliser clavier et souris ;
   - **Voir seulement** : uniquement regarder (aucune entrée n'est envoyée).
5. Cliquez sur **Se connecter**. Une fenêtre de contrôle s'ouvre.

*Avec un navigateur :* ouvrez `https://bifrost.exemple.fr`, puis mêmes champs (identifiant, mot de passe, votre nom, mode). Nécessite **HTTPS** (ou `localhost`).

### 5.3 Deux cas de figure

**Cas A : sans mot de passe (accord sur place)**

1. Le contrôleur voit un **code de vérification à 6 chiffres** (par exemple `482 913`) et « En attente de l'accord… ».
2. Sur le poste contrôlé, une **fenêtre d'accord** s'ouvre au premier plan avec le nom indiqué, l'adresse du demandeur et le même code.
3. **Comparez les deux codes à voix haute** (téléphone). S'ils sont identiques, cliquez sur **Oui**. Sinon, cliquez sur **Non** : quelqu'un s'est peut-être interposé.
4. Si personne ne répond dans les **30 secondes**, la demande est refusée.

**Cas B : avec mot de passe (accès sans surveillance)**

1. Le contrôleur saisit le mot de passe : la connexion s'établit sans fenêtre d'accord.
2. Cinq mots de passe faux de suite bloquent cette voie pendant 5 minutes (la voie « avec accord » reste utilisable).

### 5.4 Pendant la session

Sur le poste **contrôleur**, la barre en haut propose :

| Élément | Rôle |
|---|---|
| Liste **Écran n** | Visible s'il y a plusieurs écrans : choisit l'écran affiché. |
| **Presse-papiers** | Active ou coupe la synchronisation du texte (mode contrôle). |
| **Fichiers** | Panneau d'envoi/téléchargement (mode contrôle) ; on peut aussi glisser des fichiers sur l'écran. |
| **Plein écran** | Affiche l'écran distant en plein écran. |
| **Déconnecter** | Termine la session. |

Sur le poste **contrôlé**, un **bandeau rouge « Votre écran est partagé »** reste visible en permanence avec un bouton **Arrêter**. Il n'existe volontairement pas de mode invisible. La personne devant le poste peut aussi cliquer sur **« Arrêter la session »** dans la fenêtre Bifrost, à tout moment.

### 5.5 Terminer

Le contrôleur clique sur **Déconnecter**, ou le poste contrôlé clique sur **Arrêter**. Le poste contrôlé reste joignable tant que Bifrost tourne.

---

## 6. Messages courants

| Message | Signification | Que faire |
|---|---|---|
| **Serveur injoignable** (voyant) | Le poste n'arrive pas à joindre le serveur. | Vérifiez l'adresse dans *Paramètres*, la connexion Internet, et que le serveur tourne ([§7](#7-dépannage)). |
| *Cet identifiant est hors ligne ou inconnu.* | L'autre poste n'est pas connecté au serveur, ou l'identifiant est faux. | Vérifiez l'identifiant (9 chiffres) et que Bifrost est « En ligne » sur l'autre poste. |
| *Cet ordinateur est déjà en cours de contrôle.* | Une session est déjà ouverte. | Attendez qu'elle se termine. |
| *Mot de passe incorrect.* | Mauvais mot de passe. | Réessayez (5 erreurs = blocage 5 minutes). |
| *Cet ordinateur n'a pas de mot de passe…* | Vous avez saisi un mot de passe, mais aucun n'est défini. | Laissez le champ vide pour demander l'accord. |
| *La personne en face a refusé la connexion.* | Refus, ou fenêtre d'accord ignorée 30 secondes. | Recommencez, et prévenez la personne. |
| *Le chiffrement exige HTTPS…* | Page ouverte en `http://` dans un navigateur. | Utilisez `https://` (ou l'application Bifrost). |
| *Trop de tentatives, réessayez dans une minute.* | Limite de 30 demandes par minute et par adresse. | Patientez une minute. |
| *Version de protocole incompatible* | Postes de versions différentes. | Mettez à jour le poste contrôlé avec le même paquet. |

---

## 7. Dépannage

### « Serveur injoignable » sur un poste

1. **L'adresse est-elle bonne ?** *Paramètres > Serveur Bifrost*. En production : `wss://bifrost.exemple.fr` (avec `wss`, pas `ws`, et sans port).
2. **Le serveur répond-il ?** Depuis ce poste :
   ```powershell
   curl.exe -I https://bifrost.exemple.fr/
   ```
   Si ça échoue : problème de DNS, de pare-feu, de certificat, ou serveur arrêté.
3. **Un proxy d'entreprise** ou un filtrage peut bloquer les WebSocket. Testez depuis un autre réseau (partage de connexion du téléphone).
4. **Heure du poste** : un décalage important de la date/heure fait échouer la vérification du certificat HTTPS.

### Côté serveur Linux

```bash
sudo systemctl status bifrost            # le service tourne-t-il ?
journalctl -u bifrost -n 100 --no-pager  # derniers événements
sudo systemctl status caddy              # le proxy tourne-t-il ?
journalctl -u caddy -n 100 --no-pager    # erreurs de certificat (DNS, port 80 fermé…)
curl -I http://127.0.0.1:7780/           # le serveur répond en local ?
```

Causes fréquentes : DNS pas encore propagé, port 80 fermé (Caddy ne peut pas obtenir le certificat), `HOST` ou `PORT` différents entre le service et le `Caddyfile`.

### Écran distant saccadé ou en images fixes

- Bifrost utilise H.264 si le navigateur/l'application le décode, sinon JPEG. L'application Windows et Chrome/Edge décodent le H.264.
- Si l'assistant de capture n'a pas pu être compilé (antivirus, `csc.exe` absent), l'hôte retombe sur un mode JPEG à environ 10 images/s et n'affiche que l'écran principal. Fermez Bifrost, ajoutez le dossier aux exclusions de l'antivirus, relancez.

### Journaux de l'application

L'application de bureau n'écrit pas de fichier journal par défaut. Pour obtenir des messages de diagnostic, fermez Bifrost (*Quitter Bifrost*) puis lancez-la depuis PowerShell en redirigeant la sortie vers un fichier :

```powershell
$env:BIFROST_DEBUG = '1'
& "C:\Bifrost\Bifrost.exe" | Out-File "$env:USERPROFILE\bifrost-debug.log"
```

Le fichier se remplit tant que l'application tourne ; transmettez-le pour analyse.

Le service Windows, lui, écrit dans `C:\ProgramData\Bifrost\agent.log` et `service.log`.

### Réinitialiser un poste

Fermez Bifrost (*Quitter Bifrost*), puis supprimez le dossier `%APPDATA%\Bifrost`. Au prochain lancement, le poste obtient un **nouvel identifiant** et aucun mot de passe.

---

## 8. Maintenance

### Sauvegarde du serveur

Un seul fichier compte : **`ids.json`** (dossier `DATA_DIR`, soit `/var/lib/bifrost/ids.json`). Il lie chaque identifiant à son poste. Perdu, les identifiants existants pourraient être pris par d'autres postes.

```bash
sudo cp /var/lib/bifrost/ids.json ~/ids.json.$(date +%F)
```

### Mettre à jour le serveur

1. Reconstruisez ou récupérez la nouvelle version du projet.
2. Recopiez `server/`, `shared/`, `viewer/` (étape 5 du §3.2).
3. Sur le serveur :
   ```bash
   cd /opt/bifrost && npm ci --omit=dev
   sudo chown -R bifrost: /opt/bifrost
   sudo systemctl restart bifrost
   ```
   Les sessions en cours sont coupées pendant le redémarrage ; les postes se reconnectent seuls.

### Mettre à jour les postes

L'application propose elle-même les nouvelles versions publiées sur GitHub (bandeau **« Installer et redémarrer »**, voir le README). Vous pouvez aussi mettre à jour à la main : *Quitter Bifrost*, remplacez le dossier par la nouvelle version (votre identifiant et vos réglages sont dans `%APPDATA%\Bifrost` et sont conservés), relancez. Pour que les postes voient une version, publiez-la avec un tag `vX.Y.Z` (workflow `release.yml`).

### Désinstaller un poste

*Quitter Bifrost*, supprimez le dossier du programme, puis `%APPDATA%\Bifrost` et `%LOCALAPPDATA%\Bifrost`. Si vous aviez coché « Démarrer avec Windows », il suffit de décocher l'option avant de quitter.

---

## 9. Bonnes pratiques de sécurité

- **HTTPS obligatoire** pour tout usage sur Internet. Ne servez jamais le serveur en clair hors de votre réseau local.
- **Mot de passe long et unique** (12 caractères minimum) pour l'accès sans surveillance. Un service SYSTEM avec mot de passe est un accès complet à la machine.
- **Comparez toujours le code à 6 chiffres** en mode « accord » : c'est lui qui protège contre un serveur malveillant.
- **N'exposez pas le port 7780** : seul le proxy (443) doit être joignable.
- **Ne confiez pas l'hébergement du serveur à un tiers si vous servez la visionneuse web** : celui qui exploite le serveur pourrait servir une version modifiée de la page. Pour un public externe, préférez l'application installée.
- **Sauvegardez `ids.json`** et limitez l'accès SSH du serveur (clés, pas de mot de passe).

### Limites à connaître avant de proposer Bifrost à des tiers

- Programme **non signé** : l'avertissement SmartScreen apparaît à chaque nouvelle machine.
- **Pas d'installeur ni de mise à jour automatique** (copie de dossier, voir le §8).
- **Windows uniquement** pour le poste contrôlé et l'application de bureau.
- **Tout transite par le serveur** : pas de connexion directe entre les postes (simple et fiable, mais cela consomme la bande passante du serveur).
- Version **0.x, non auditée** par un tiers.
- Le **service Windows** (écran de verrouillage, UAC) n'a été testé qu'en partie : suivez la liste « À vérifier » du README.
