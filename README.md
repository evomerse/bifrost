# Bifrost

Prise en main à distance **auto-hébergée** : pas de licence, pas de limite de durée de session, aucune dépendance à un service tiers. Code original (aucun code d'AnyDesk ni d'un autre produit).

> **Installer et utiliser Bifrost pas à pas (serveur, postes, connexion) : voir [INSTALLATION.md](INSTALLATION.md).**

```
 PC contrôlé                    Serveur Bifrost                 Contrôleur
┌──────────────┐  WebSocket   ┌─────────────────┐  WebSocket  ┌────────────────┐
│ agent (Node) │─────────────▶│ annuaire d'ID   │◀────────────│ navigateur web │
│ capture      │              │ appairage+relais│             │ (aucune install)│
│ entrées      │◀─────────────│ sert la page web│─────────────▶             │
└──────────────┘              └─────────────────┘             └────────────────┘
```

## Application de bureau (Windows, macOS, Linux)

Un seul programme, comme AnyDesk : une fenêtre **Bifrost** qui sert à la fois de *poste contrôlé* et de *poste contrôleur*.

```powershell
npm install
npm run dist                      # construit dist\Bifrost-win32-x64\Bifrost.exe (dossier autonome, ~370 Mo)
.\dist\Bifrost-win32-x64\Bifrost.exe

npm run desktop                   # ou : lancer directement depuis les sources
```

**Cet ordinateur** : votre identifiant (à donner), l'état de la connexion, le mot de passe d'accès sans surveillance, ce que les personnes connectées peuvent faire en plus (presse-papiers, fichiers : accord à chaque fois / sans demander / désactivé), les dossiers partagés.
**Contrôler un autre ordinateur** : identifiant + mot de passe facultatif, « prendre le contrôle » ou « voir seulement » ; chaque connexion ouvre une fenêtre de contrôle (la visionneuse, avec presse-papiers, fichiers, plein écran). Les identifiants récents sont mémorisés.

Ce qui se passe quand quelqu'un se connecte à vous :
- une **fenêtre d'accord** s'ouvre au premier plan, avec le nom indiqué (non vérifié), l'adresse et le **code de vérification** à comparer ; « Refuser » est le bouton par défaut, fermer la fenêtre ou ne rien faire pendant 30 s refuse ;
- tant que la session dure, une **boîte de session** (pastille rouge, qui regarde, bouton rouge « Arrêter ») reste au-dessus de tout, en bas à droite de l'écran, comme dans TeamViewer : repliée en simple barre, elle se déplie toute seule quand la personne en face écrit, et on y répond sans ouvrir la fenêtre principale (qui a aussi « Arrêter la session ») ;
- avec un mot de passe défini, la personne qui le connaît entre sans accord (sauf si vous cochez « Toujours demander mon accord »).

**Serveur** : l'application a besoin d'un relais Bifrost. Deux façons :
- en avoir un ailleurs (`npm run server` derrière un proxy HTTPS) et saisir son adresse dans *Paramètres* ;
- ou **cocher « Faire fonctionner le serveur sur cet ordinateur »** : l'application embarque le relais, affiche les adresses `ws://…` à donner aux autres appareils du réseau, et s'y connecte elle-même. Pour Internet, redirigez le port et placez un proxy HTTPS devant.

Elle reste dans la **zone de notification** quand on ferme la fenêtre (le PC reste joignable) ; *Paramètres* permet de la lancer avec Windows ou de la quitter vraiment.

Particularités à connaître :
- l'identifiant et les droits sont ceux de `%APPDATA%\Bifrost\agent.json`, communs avec l'agent en ligne de commande : **ne lancez pas les deux en même temps** (ils se déconnecteraient mutuellement) ;
- pour être joignable **avant l'ouverture de session** ou pour voir l'écran de verrouillage/UAC, il faut le service Windows (voir plus bas) : l'application de bureau, elle, tourne dans votre session ;
- le programme n'est **pas signé** : Windows SmartScreen affichera un avertissement au premier lancement (« Informations complémentaires » puis « Exécuter quand même ») ; un certificat de signature de code est nécessaire pour l'éviter ;
- pas d'installeur : c'est un dossier à copier. Les fichiers PowerShell et l'assistant vidéo doivent rester à côté de `Bifrost.exe` (le paquet n'utilise volontairement pas d'archive asar).

Sécurité de l'application : fenêtres isolées (sandbox, pas de Node.js dans les pages, outils de développement coupés), pages servies par un schéma interne `bifrost://` avec une politique de contenu stricte, navigation et ouverture de fenêtres bloquées, permissions du navigateur limitées au presse-papiers et au plein écran pour la visionneuse, mot de passe transmis une seule fois à la fenêtre de contrôle et jamais mis dans une adresse.
### Ce qui est propre à chaque système

| | Windows | macOS | Linux |
|---|---|---|---|
| Capture | assistant natif H.264 (repli PowerShell) | Electron, JPEG | Electron, JPEG |
| Souris / clavier | `SendInput` | CoreGraphics via `osascript` | `xdotool` (X11) |
| Presse-papiers | assistant PowerShell | Electron | Electron |
| Droits à accorder | aucun | *Enregistrement de l'écran* + *Accessibilité* | une session X11 et `xdotool` installé |
| Service avant l'ouverture de session | oui | non | non |
| Agent en ligne de commande | oui | non (application seulement) | non (application seulement) |

> **Statut des ports macOS et Linux.** Le chemin de capture d'Electron (utilisé hors Windows) est testé de bout en bout sur Windows (`BIFROST_PORTABLE=1`) ; la traduction des entrées (scancodes → touches X11 / CGKeyCode, protocole d'`osascript` et de `xdotool`) est testée à l'unité. **Aucun test n'a eu lieu sur un vrai macOS ou Linux** : attendez-vous à devoir corriger des détails. Voir [INSTALLATION.md §4.5](INSTALLATION.md#45-macos-et-linux).

## Interface

Disposition inspirée de RustDesk (barre de navigation à gauche, votre identifiant d'un côté, la connexion de l'autre) avec la sobriété d'AnyDesk : clair ou sombre selon le système, un seul accent bleu. **Heimdall** (assistant) et **Réglages** sont deux boutons ronds flottants en bas à droite.

Le logo est l'officiel (`desktop/assets/logo-source.jpg`). C'est le seul endroit qui joue l'effet Bifrost : un halo arc-en-ciel autour du logo, une fois, quand une connexion s'établit (vers un autre ordinateur ou depuis un autre vers celui-ci). Désactivé si le système demande de réduire les animations.

**Discussion entre les deux personnes** : pendant une session, un bouton « Discussion » apparaît des deux côtés (dans la barre de la visionneuse, et en bas à droite de la fenêtre de l'ordinateur contrôlé). Les messages passent par le même canal chiffré de bout en bout que l'écran, le relais ne les lit pas ; ils restent **en mémoire seulement** et disparaissent à la fin de la session (rien n'est écrit sur disque). Disponible en « voir seulement » aussi. Sur l'ordinateur contrôlé, les messages arrivent dans la boîte de session en bas à droite, qui se déplie d'elle-même sans prendre le focus. 2 000 caractères par message, 20 messages par tranche de 10 s au maximum. Pas de discussion avec l'agent en ligne de commande ni le service Windows (rien pour l'afficher).

Pendant le contrôle, **un seul pointeur** est visible : celui de l'ordinateur distant (déjà dessiné dans la vidéo). Le pointeur local est masqué au-dessus de l'écran distant ; en « voir seulement », il reste affiché.

## Mises à jour automatiques

L'application consulte les *releases* GitHub de `evomerse/bifrost` (au démarrage puis toutes les 6 h ; désactivable dans *Paramètres → Mises à jour*, ou `BIFROST_UPDATE_REPO=propriétaire/dépôt` pour un fork). Quand une version plus récente existe, un bandeau propose **« Installer et redémarrer »** :

1. téléchargement de l'archive de votre système (`Bifrost-<tag>-<système>-<arch>.zip` ou `.tar.gz`) ;
2. vérification de son empreinte **SHA-256** contre `SHA256SUMS.txt` de la même publication (sans ce fichier, la mise à jour est refusée) ; seules les adresses `https://github.com/<dépôt>/releases/download/…` sont acceptées ;
3. l'application quitte, un petit script remplace son dossier (l'ancien est restauré en cas d'échec) et la relance. Vos réglages (`%APPDATA%Bifrost`) sont conservés.

Une copie lancée depuis les sources (`npm run desktop`) ne s'installe pas toute seule : le bandeau renvoie vers la page GitHub.

**Publier une version** : mettre à jour `version` dans `package.json`, committer, puis `git tag v0.3.0 && git push origin v0.3.0`. Le workflow `.github/workflows/release.yml` construit Windows, macOS (arm64 et x64) et Linux, calcule `SHA256SUMS.txt` et crée la release. Les paquets ne sont **pas signés** : l'empreinte protège d'un téléchargement corrompu, pas d'un dépôt compromis.

## Heimdall, l'assistant IA

*Paramètres → Heimdall → Activer* fait apparaître un onglet de discussion. Heimdall comprend des demandes comme « vide la corbeille », « vérifie les mises à jour Windows », « combien reste-t-il sur mes disques ? » et agit sur **l'ordinateur où l'application tourne**.

- **Fournisseurs** : Groq Cloud (gratuit, par défaut ; tutoriel intégré aux paramètres), ChatGPT (OpenAI), Grok (xAI), Gemini (Google), Claude (Anthropic), ou **Claude Code** (le programme `claude` installé sur le PC, sans clé). Chaque fournisseur a son modèle par défaut, modifiable.
- **Votre clé, votre compte** : les requêtes partent directement de votre PC vers le fournisseur choisi, jamais par le relais Bifrost. La clé est chiffrée par le coffre du système (DPAPI, Trousseau, libsecret) ; sans coffre disponible elle est stockée en clair et l'interface le dit.
- **Des outils précis, pas un accès libre** : `system_info`, `disk_usage`, `top_processes`, `check_updates` (lecture seule, sans confirmation) ; `empty_trash`, `clean_temp_files` et `run_command` demandent **à chaque fois** votre accord dans une fenêtre native du programme, avec le texte exact de ce qui va être fait. La page web et le modèle ne peuvent pas répondre à votre place.
- La conversation reste en mémoire seulement (« Nouvelle conversation » l'efface). Ce que Heimdall voit d'une commande (sa sortie) est envoyé au fournisseur : n'activez pas `run_command` pour des données sensibles.
- Avec **Claude Code**, Heimdall ne passe pas par les appels d'outils de l'API : il demande au modèle un bloc JSON décrivant l'outil, qu'il exécute avec les mêmes confirmations.

**Heimdall pendant une prise en main** : en « Prendre le contrôle » (application de bureau), un bouton ✨ **Heimdall** apparaît dans la barre de la visionneuse. Ses outils agissent alors sur **l'ordinateur distant**, pas sur le vôtre : chaque appel part par le canal chiffré de bout en bout vers l'hôte, qui n'exécute que la liste d'outils ci-dessus. Les actions qui modifient quelque chose vous demandent **votre** accord (fenêtre native de votre Bifrost, texte exact de la commande) ; la personne en face voit chaque action écrite dans sa boîte de session (« L'assistant de Camille exécute une commande : … »). La clé API et la conversation restent sur **votre** PC. Le propriétaire de l'ordinateur contrôlé peut l'interdire (*Autorisations → Laisser l'assistant Heimdall…*, activé par défaut) ; l'assistant n'est jamais offert en « Voir seulement », ni par l'agent en ligne de commande ou le service Windows.

## Démarrage rapide (test en local, sans l'application)

Prérequis : Node 20+ (testé avec Node 24), Windows pour l'agent.

```powershell
npm install

# 1. Serveur (une fois, sur la machine qui sert de relais)
npm run server                     # http://localhost:7780

# 2. Agent, sur le PC à contrôler
node agent/agent.js --server ws://localhost:7780/ws
node agent/agent.js id             # affiche l'identifiant à 9 chiffres
node agent/agent.js set-password   # facultatif : accès sans surveillance

# 3. Contrôleur : ouvrir http://localhost:7780 dans un navigateur
```

Sans mot de passe, **chaque connexion déclenche une fenêtre d'accord** sur le PC contrôlé. Avec un mot de passe, la personne qui le connaît entre directement (option `--require-consent` pour redemander l'accord quand même).

## Mise en ligne

1. Placez le serveur derrière un proxy TLS (Caddy, nginx…) et lancez-le avec `TRUST_PROXY=1`, ou donnez-lui `TLS_CERT` / `TLS_KEY`. **HTTPS est obligatoire** : le navigateur refuse le chiffrement (WebCrypto) hors HTTPS/localhost, et le TLS protège en plus la page elle-même (un serveur sans TLS pourrait vous servir un faux JavaScript).
2. Variables du serveur : `PORT` (7780), `HOST`, `DATA_DIR` (`./data`, contient `ids.json`), `TRUST_PROXY`, `TLS_CERT`, `TLS_KEY`.
3. Sur chaque PC : `node agent/agent.js --server wss://bifrost.exemple.fr`.

## Vidéo : H.264 avec repli JPEG

La capture est faite par un petit programme natif, `BifrostCapture.exe`, compilé automatiquement à partir de `native/` avec le `csc.exe` de Windows (au premier lancement, dans `%LOCALAPPDATA%\Bifrost\bin`, ou à l'installation du service). Il encode en **H.264 avec l'encodeur Media Foundation de Windows** (faible latence, sans image B), sans aucune bibliothèque tierce.

- **Négociation** : la visionneuse annonce ce qu'elle décode (WebCodecs, Chrome/Edge/Safari récents, en HTTPS ou localhost) dans son premier message chiffré ; l'agent choisit H.264, sinon JPEG. Si le navigateur annonce H.264 mais échoue sur le flux réel, il demande lui-même le repli JPEG en cours de session.
- **Écran inchangé = rien envoyé** : une image identique à la précédente n'est ni encodée ni transmise.
- **Perte de synchronisation** : en H.264 chaque image dépend des précédentes ; en cas de ralentissement du lien l'agent ne reprend qu'à l'image clé suivante, qu'il demande aussitôt. La visionneuse peut aussi en réclamer une.
- **Débit adaptatif** : de 4 Mbit/s vers le bas (jusqu'à 0,6) dès que le lien sature, remontée progressive ensuite.
- **Mesuré sur cette machine** (écran 2560×1440 réduit à 1920×1080, écran peu animé) : 0,5 Mbit/s en H.264 contre 19,6 Mbit/s en JPEG ; par image : capture ~30 ms, conversion 3 ms, encodage 2,6 ms.

Si `csc.exe` est absent, l'agent retombe sur le grabber PowerShell (JPEG, ~10 images/s, écran principal seulement).

## Plusieurs écrans

Quand le PC contrôlé a plusieurs écrans, la barre de la visionneuse affiche une liste **« Écran 1 (principal) · 2560×1440 », « Écran 2 · … »** : un choix bascule le flux sur cet écran (nouvelle image clé, redimensionnement automatique) et le pointeur est ramené sur lui, y compris pour un écran placé à gauche ou au-dessus du principal. Aucun réglage côté hôte.

- Le principal est toujours l'écran 1 et reste l'écran affiché au départ ; la liste suit les branchements et les changements de résolution (relecture chaque seconde).
- Le changement d'écran est permis aussi en « voir seulement » : la personne qui a accepté a accepté de partager « cet ordinateur », pas un écran en particulier. La visionneuse ne reçoit que les tailles, jamais les positions.
- Un seul écran est affiché à la fois (pas de bureau étendu d'un seul tenant) ; pas de liste avec le grabber PowerShell de secours.
- Les écrans à échelle d'affichage différente (125 %, 150 %…) sont capturés dans les pixels du système ; non vérifié avec des échelles mélangées.
## Presse-papiers et transfert de fichiers

Disponibles dans le site, **uniquement en mode « prendre le contrôle »** (jamais en « voir seulement »), et chiffrés de bout en bout comme le reste.

**Presse-papiers (texte)**
- Ce que vous copiez sur le PC distant arrive dans votre presse-papiers local ; ce que vous copiez chez vous est envoyé au PC distant quand vous faites **Ctrl+V** dans la fenêtre de contrôle (l'envoi est confirmé par l'hôte avant que le Ctrl+V parte).
- Le bouton « Presse-papiers » de la barre l'active ou le coupe. Si le navigateur refuse l'écriture automatique (Firefox, Safari), un bouton « Copier le presse-papiers distant » apparaît.
- Texte seulement, 512 Ko au maximum par envoi. Pas d'images ni de fichiers copiés.

**Fichiers**
- Bouton **Fichiers** : panneau avec les dossiers partagés, envoi par sélecteur ou par **glisser-déposer sur l'écran**, téléchargement, progression, annulation.
- Reprise des gros fichiers directement sur le disque avec Chrome/Edge ; les autres navigateurs gardent le fichier en mémoire (limité à 1 Go).
- Par défaut, **à chaque fichier, la personne devant le PC doit accepter** (fenêtre avec le nom et la taille).

**Ce qui est partagé : uniquement des dossiers déclarés, jamais le disque entier**

| Dossier | Où | Droits |
|---|---|---|
| `Inbox` | `%USERPROFILE%\Bifrost Transfers\Inbox` | dépôt (et lecture) |
| `Outbox` | `%USERPROFILE%\Bifrost Transfers\Outbox` | lecture : y placer ce qu'on veut rendre récupérable |
| vos dossiers | ajoutés par vous | lecture, dépôt si `--share-write` |

```powershell
node agent/agent.js permissions                                   # afficher
node agent/agent.js permissions --files ask|allow|deny            # accord à chaque fichier / sans demander / désactivé
node agent/agent.js permissions --clipboard on|off
node agent/agent.js permissions --share "D:\Documents" --share-name Docs [--share-write]
node agent/agent.js permissions --unshare Docs
```

Garde-fous : les noms de fichiers sont nettoyés (pas de `..`, de chemins, de noms réservés Windows ni de flux alternatifs) ; un fichier n'écrase jamais un fichier existant (`nom (1).ext`) ; il n'apparaît qu'une fois reçu en entier (écriture dans un `.bifrost-part`) ; les liens symboliques et jonctions qui sortent d'un dossier partagé sont refusés ; taille limitée à 4 Go ; au plus 4 transferts à la fois. Rien n'est créé sur le PC tant qu'une personne n'a pas été acceptée en mode contrôle.

**En service Windows (SYSTEM)** : un seul dossier, `C:\ProgramData\Bifrost\Transfers\Inbox`, en **dépôt seulement** et en lecture seule pour les utilisateurs ; pas d'`Outbox` ni de dossiers ajoutés. Raison : un service SYSTEM qui lirait un dossier où un utilisateur normal peut créer des jonctions pourrait être détourné pour lire n'importe quel fichier. Récupérer des fichiers depuis un service demande de lire en tant qu'utilisateur connecté, non fait.
## Service Windows (démarrage au boot, écran de connexion, fenêtres UAC)

Lancé à la main, l'agent s'exécute avec vos droits et ne voit ni l'écran de connexion ni les fenêtres UAC (bureau sécurisé). En **service**, il démarre avec Windows, avant toute ouverture de session, et tourne en SYSTEM dans la session console : il suit le bureau actif et voit donc écran de connexion, écran de verrouillage et invites UAC.

```powershell
# PowerShell lancé EN ADMINISTRATEUR, dans le dossier du projet
node agent/agent.js set-password --service        # 12 caractères minimum, avant d'installer
node agent/agent.js service install --server wss://bifrost.exemple.fr
node agent/agent.js service status                # état + identifiant
node agent/agent.js service uninstall [--purge]   # --purge efface aussi l'identifiant et le mot de passe
```

Ce que fait l'installation, sans rien cacher :
- copie le programme, ses scripts et **sa propre copie de `node.exe`** dans `C:\Program Files\Bifrost` (écriture réservée aux administrateurs : tout ce qui s'exécute en SYSTEM doit être là, sinon n'importe quel programme lancé par un utilisateur normal pourrait le modifier et devenir SYSTEM) ;
- compile le petit hôte de service avec le `csc.exe` fourni par Windows (aucun SDK à installer) ;
- reprend votre identifiant, votre serveur et votre mot de passe dans `C:\ProgramData\Bifrost\agent.json`, illisible par les utilisateurs normaux ; un dossier ou fichier de données préexistant créé par un non-administrateur est supprimé, jamais adopté ;
- crée le service **BifrostAgent** (visible dans `services.msc`, redémarrage automatique en cas de plantage) et le démarre.

Le bandeau « écran partagé » s'affiche toujours sur le bureau de la personne présente. Avant l'ouverture de session il n'y a personne pour le voir, c'est pourquoi **le mot de passe est indispensable** pour le service : sans lui, aucune connexion ne peut être acceptée à ce moment-là (l'accord expire et est refusé).

Les journaux sont dans `C:\ProgramData\Bifrost` (`service.log`, `agent.log`, rotation automatique). N'exécutez pas en même temps l'agent « manuel » et le service avec le même identifiant : ils se déconnecteraient mutuellement.

### À vérifier chez vous après l'installation

Ces points exigent un vrai service SYSTEM et ne peuvent pas être couverts par les tests automatiques :

1. `service status` indique `RUNNING` et un identifiant ; `agent.log` contient « En ligne ».
2. Connexion depuis la visionneuse : l'écran s'affiche.
3. **Verrouillez le PC (Win+L)** : l'écran de verrouillage doit s'afficher dans la visionneuse et le clavier doit permettre de saisir le mot de passe Windows.
4. Déclenchez une invite **UAC** (clic droit > Exécuter en tant qu'administrateur) : elle doit être visible et cliquable à distance.
5. **Redémarrez le PC** sans vous connecter : l'identifiant doit redevenir joignable depuis la visionneuse sur l'écran de connexion.

Si l'un de ces points échoue, `service.log` indique l'erreur Windows exacte (par exemple le nom de l'appel système refusé).

## Intégration dans votre site

La visionneuse (`viewer/`) est une page autonome : vous pouvez la servir telle quelle, l'ouvrir dans un `<iframe>` (retirer `frame-ancestors 'none'` dans `server/server.js`) ou reprendre `viewer.js`. Le protocole est décrit ci-dessous : n'importe quel front peut le parler.

## Protocole (WebSocket `/ws`)

Poignée de main en JSON clair (rien de secret n'y circule), puis **tout est chiffré** de bout en bout :

| Sens | Message |
|---|---|
| hôte → serveur | `{t:"host", id, secret}` |
| viewer → serveur | `{t:"viewer"}` puis `{t:"connect", id}` |
| serveur → pair | `{srv:"peer"\|"paired"\|"peer-left"\|"ended"\|"error", …}` (clé `srv` réservée au serveur, tout message relayé qui la contient est supprimé) |
| hôte → viewer | `challenge {v:2, salt, iters, nonce, hasPassword, host}` |
| viewer → hôte | `commit {c = SHA256(clé éphémère du viewer)}` |
| hôte → viewer | `hello-key {hpub}` (clé ECDH P-256 éphémère de l'hôte) |
| viewer → hôte | `auth {vpub, pw, d}` où `d` est le premier message chiffré `{mode, label}` |
| ensuite, dans les deux sens (binaire) | `[0x02][compteur u64][AES-256-GCM(type + corps)]` ; type 1 = image JPEG (`u16 largeur, u16 hauteur, JPEG`), type 2 = JSON (`accepted`, `denied`, `bye`, `mv md mu wh kd ku tx`, `key`, `codec`, `monitors` (hôte → viewer : `{current, list:[{w,h,primary}]}`) et `mon` (viewer → hôte : `{i}`)…), type 3 = vidéo H.264 (`u8 drapeaux` bit 0 = image clé, `u16 largeur, u16 hauteur`, flux Annex B), type 4 = morceau de fichier (`u32 id de transfert`, `u8 drapeaux` bit 0 = dernier, données). Messages de ce chapitre : `perm`, `clip`, `clip-set`, `fs-list`, `fs-get`, `fs-put`, `fs-cancel` et leurs réponses `fs-*-r`, `fs-done`, `fs-error` |

## Chiffrement de bout en bout

- Clés : ECDH P-256 **éphémère** à chaque session (donc confidentialité persistante), HKDF-SHA256, une clé AES-256-GCM par sens, compteurs strictement croissants : un paquet modifié, rejoué, supprimé ou réordonné coupe la session.
- **Avec mot de passe** : la clé dérivée du mot de passe (PBKDF2-SHA256, 200 000 itérations) est mélangée aux clés. Un serveur qui ne connaît pas le mot de passe ne peut pas terminer l'échange ; un mauvais mot de passe échoue au déchiffrement.
- **Sans mot de passe (accord)** : les deux écrans affichent un **code de vérification à 6 chiffres** dérivé de l'échange. Le viewer s'engage sur sa clé *avant* de voir celle de l'hôte, ce qui interdit à un serveur malveillant de chercher des codes identiques : une substitution se voit quand les deux personnes comparent. La fenêtre d'accord sur le PC contrôlé l'indique.
- Le serveur ne voit que des métadonnées : identifiants, adresses IP, durées et tailles de paquets.

## Sécurité : ce qui est en place

- Fenêtre d'accord par défaut, avec adresse du demandeur ; le nom indiqué est marqué « non vérifié » et nettoyé (caractères de contrôle et bidi retirés).
- **Bandeau « écran partagé » (pastille rouge) + bouton Arrêter** toujours visible pendant une session. Il n'y a volontairement pas de mode invisible.
- Mot de passe : seule une clé dérivée est stockée ; 5 échecs ⇒ blocage 5 min de la voie mot de passe (la voie « accord » reste ouverte).
- Un identifiant est lié au secret de son hôte (premier arrivé) : impossible de le reprendre avec un autre secret.
- Le serveur ne sert qu'une liste fixe de fichiers, avec CSP stricte ; limite de tentatives de connexion par IP.
- Le mode « voir seulement » n'ouvre jamais l'injecteur d'entrées.

## Limites actuelles (v0.1), à connaître

- **Comparer le code en mode « accord » est indispensable** : si personne ne le compare, un serveur malveillant qui falsifie l'échange pourrait s'intercaler. Avec un mot de passe, cette vérification n'est pas nécessaire.
- **Mot de passe : choisissez-le long** (12 caractères ou plus). Ce n'est pas un protocole PAKE : un serveur activement malveillant qui s'intercale peut tenter de deviner un mot de passe faible hors ligne, à raison de 200 000 itérations PBKDF2 par essai. Un serveur passif ne peut rien en tirer.
- **La visionneuse web vient du même serveur que le relais** : le chiffrement protège contre l'écoute du réseau et contre un relais qui se contente de lire, pas contre l'exploitant du serveur qui servirait un JavaScript modifié. Tant que le serveur est le vôtre, c'est sans conséquence ; pour l'héberger au profit de tiers, servez la visionneuse depuis un domaine distinct ou fournissez-la en application installée.
- **L'identifiant n'est pas une preuve d'identité** : ce qui authentifie l'hôte, c'est le mot de passe ou le code comparé.
- **Cadence** : environ 25 images/s à 1080p. Le plafond est la copie d'écran GDI (~30 ms par image sur un écran 1440p) ; le passer au-dessus de 30 demande la capture par DXGI Desktop Duplication, non faite.
- **Décodage H.264 vérifié dans Chromium (Electron 44 / Chrome 152) seulement** : l'application de bureau l'a fait fonctionner en conditions réelles (image 1920×1080 décodée par WebCodecs, couleurs plausibles, permissions et fichiers via la page). Chrome, Edge et Opera partagent ce moteur ; Firefox et Safari n'ont pas été essayés et retombent automatiquement en JPEG si WebCodecs ou le profil H.264 leur manque. Les couleurs supposent la matrice BT.709 sans en-tête VUI.
- **Pas de WebRTC** : le transport reste le relais WebSocket (TCP) : pas de pair-à-pair, pas de contrôle de congestion propre à la vidéo en temps réel. Le gain de fluidité vient du codec H.264, pas du transport.
- **Pas encore** : images ou fichiers dans le presse-papiers (texte seulement), explorateur de fichiers sur tout le disque, son, chat, impression, mobile, installeur signé ; sur macOS et Linux : H.264 (JPEG seulement), service avant l'ouverture de session, agent en ligne de commande, Wayland (pas d'injection d'entrées).
- **Le service SYSTEM n'a été testé qu'en partie** : compilation, installation par étapes, supervision (démarrage, relance, nettoyage d'un agent orphelin) et lancement via duplication de jeton, avec vos propres droits. Le suivi du bureau sécurisé (écran de verrouillage, UAC) et l'exécution réelle en SYSTEM n'ont pas pu être exercés sans droits administrateur : suivez la liste « À vérifier » ci-dessus.
- **Un service SYSTEM avec accès sans surveillance est un accès total à la machine** : la sécurité repose sur le mot de passe (12 caractères minimum, blocage 5 min après 5 échecs) et sur le serveur relais. Mot de passe long et unique, serveur en HTTPS.
- Ctrl+Alt+Suppr ne peut pas être envoyé à distance pour l'instant (il faut appeler `SendSAS` depuis le service et régler la stratégie `SoftwareSASGeneration`, non fait).
- Une seule session console, un écran affiché à la fois ; les sessions Bureau à distance (RDP) ne sont pas ciblées.
- Pas de relais TURN/pair-à-pair : tout transite par le serveur (simple et fiable, mais consomme sa bande passante).

## Tests

```powershell
npm test                               # crypto, serveur, session, fichiers, interface, assistant natif, scripts PowerShell, service,
                                       # entrées macOS/Linux, mises à jour, Heimdall
$env:BIFROST_E2E='1'; npm test         # + bout en bout et application de bureau réelle (Electron), dont le chemin de capture portable
                                       #   hôte + visionneuse dans un vrai Chromium : H.264, mot de passe, accord,
                                       #   code de vérification, bandeau, fichiers, relais intégré (affiche brièvement le bandeau)
```

## Structure

`server/` annuaire + relais + fichiers statiques · `agent/` agent hôte, helpers PowerShell et gestion du service · `service/BifrostService.cs` hôte de service Windows (superviseur) · `native/` assistant de capture et d'encodage H.264 (C#) · `shared/auth.js` dérivation du mot de passe, identifiants · `shared/e2e.js` chiffrement de bout en bout (Node et navigateur) · `viewer/` page de contrôle (site et application) · `desktop/` application de bureau Electron (fenêtres, icônes, `updater.mjs` mises à jour GitHub, `heimdall/` assistant IA, `capture-electron.mjs` capture macOS/Linux) · `agent/helpers-portable.js` + `agent/input-portable.js` helpers macOS/Linux · `scripts/` construction du paquet · `test/`
