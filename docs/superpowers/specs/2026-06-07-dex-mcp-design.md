# DEX-MCP — Design

- **Date**: 2026-06-07
- **Status**: Approved design, pre-implementation
- **Repository**: https://github.com/972jesko/dex-mcp
- **License**: MIT
- **One-liner**: Outillage de debug et inspection pour projets Roblox, exposé comme serveur MCP afin qu'un agent IA puisse explorer l'arbre d'instances, lire/écrire des propriétés, appeler des remotes et exécuter du Luau dans un client Roblox piloté par executor.

## 1. Goal & context

DEX Explorer est un GUI Luau (~8000 lignes) qui tourne dans un client Roblox via executor : il fournit un explorer d'instances, un panneau de propriétés, une recherche, un appelleur de remotes et un dump d'instances. Ce projet **ne convertit pas** ce GUI. Il en **réimplémente les capacités** sous forme de serveur MCP, pour qu'un agent IA (Claude Desktop, Cline, Cursor…) soit l'interface au lieu d'un GUI.

Usage visé : debug, inspection, apprentissage et reverse de **ses propres projets Roblox** en local.

### Non-goals (boundary)

- Aucune feature d'évasion d'anti-cheat ou d'anti-détection.
- Pas d'automatisation de masse contre des jeux tiers.
- Pas de réutilisation du code GUI de DEX (seulement sa liste de capacités comme référence).

## 2. Architecture

Deux artefacts reliés par un protocole RPC sur WebSocket.

```
   AI Agent (Claude/Cline/Cursor)
        │  MCP over stdio
        ▼
   ┌──────────────────────────┐      ws://127.0.0.1:8392?token=…
   │  MCP server (TypeScript)  │◄──────────────────────────────┐
   │  - outils MCP (stdio)     │                                │
   │  - hub WebSocket          │                                ▼
   │  - cache API dump         │                  ┌──────────────────────────┐
   │  - corrélation req/resp   │                  │  Bridge Luau (executor)  │
   └──────────────────────────┘                  │  WebSocket.connect(...)  │
                                                  │  pcall + dispatch        │
                                                  │  ref tables (faibles)    │
                                                  └──────────────────────────┘
                                                             │
                                                         game (DataModel)
```

- **Serveur** : TypeScript/Node ≥ 18, `@modelcontextprotocol/sdk`, transport **stdio** vers l'agent + **serveur WebSocket local** pour le bridge. Possède l'API dump (fetch + cache disque) et la corrélation requête/réponse (un appel d'outil MCP est req/resp, le WS est asynchrone → table de promesses en attente, clé = `id`).
- **Bridge** : `dex-bridge.luau`, collé dans l'executor. Boucle de messages, dispatch, `pcall` par commande.
- **Langages** : TypeScript (serveur), Luau (bridge — imposé par Roblox).

### Data flow (un appel d'outil)

`get_children({ref})` → le serveur crée `{id, method:"getChildren", params}`, l'envoie sur le WS, enregistre une promesse `id` → le bridge exécute contre `game`, répond `{id, ok:true, result:[…]}` → le serveur résout la promesse → renvoie le résultat structuré à l'agent.

### Connection lifecycle

- Le serveur démarre, écoute. Si un outil est appelé sans bridge connecté → erreur claire : « Bridge non connecté. Colle le script bridge dans ton executor. »
- Le bridge a une boucle de reconnexion (l'executor peut couper la connexion).
- **v1 = un seul bridge** (un client Roblox). Multi-client = futur (cf. §12).

## 3. Composants (unités isolées)

Chaque unité a une responsabilité unique, une interface claire, et est testable seule.

| Unité | Fichier | Rôle | Dépend de |
|---|---|---|---|
| Entry | `src/index.ts` | Démarre stdio MCP + hub WS, lit la config | config, mcp/server, bridge-hub |
| MCP server | `src/mcp/server.ts` | Enregistre les outils, mappe outil → RPC | rpc, tools/* |
| Tools | `src/mcp/tools/*.ts` | Un fichier par groupe (explore, write, remotes, luau, status) | rpc, protocol, api-dump |
| WS hub | `src/bridge-hub/ws-server.ts` | Accepte le bridge, valide le token, gère la connexion | config |
| RPC | `src/bridge-hub/rpc.ts` | Corrélation id→promesse, timeout, erreurs | ws-server |
| Protocol | `src/protocol.ts` | Types + schémas Zod des valeurs taggées et du `Node` (validation côté TS) ; l'encode/décode réel est côté bridge Luau | — |
| API dump | `src/api-dump/{fetch,properties}.ts` | Télécharge/cache le dump, dérive les propriétés par classe | — |
| Config | `src/config.ts` | Port, token, flags | — |
| Bridge | `bridge/dex-bridge.luau` | WS, ref tables, dispatch, codec Luau jumeau | — |

## 4. Protocole RPC (serveur ↔ bridge)

Enveloppe JSON sur WebSocket.

**Requête** (serveur → bridge) : `{ "id": number, "method": string, "params": object }`
**Réponse** (bridge → serveur) : `{ "id": number, "ok": boolean, "result"?: any, "error"?: string }`
**Événement non sollicité** (bridge → serveur, ex. remote spy) : `{ "event": string, "data": any }` (pas d'`id`).

`id` monotone côté serveur. Timeout par requête (défaut 15 s) → rejette la promesse avec une erreur « bridge timeout ». Toute commande bridge est enveloppée dans `pcall` ; une erreur Luau devient `{ok:false, error}`, jamais un crash du bridge.

### Méthodes

| Méthode | params | result |
|---|---|---|
| `status` | — | `{gameName, placeId, clientVersion, capabilities}` |
| `getRoot` | — | `{node, services: node[]}` (game = ref 0) |
| `getChildren` | `{ref, classFilter?}` | `node[]` |
| `getProperties` | `{ref, propertyNames?}` | `{className, properties: {name: TaggedValue}}` |
| `setProperty` | `{ref, name, value, valueType?}` | `{ok:true}` |
| `search` | `{rootRef, query, classFilter?, limit, maxDepth?}` | `node[]` |
| `getSource` | `{ref}` | `{source}` ou erreur |
| `fireRemote` | `{ref, args}` | `{ok:true}` |
| `invokeRemote` | `{ref, args}` | `{result: TaggedValue}` |
| `remoteSpyStart` | `{filter?}` | `{ok:true}` (capability-gated) |
| `remoteSpyStop` | — | `{ok:true}` |
| `remoteSpyDump` | — | `{entries: […]}` |
| `runLuau` | `{code}` | `{output: string, returned?: TaggedValue}` |

`node = { ref:number, name:string, className:string, path:string, childCount:number }`

`capabilities = { websocket:bool, hookmetamethod:bool, getrawmetatable:bool, ... }` — détecté au démarrage du bridge, sert au capability-gating (cf. remote spy).

## 5. Adressage des instances — ref handles + path

- **Ref id** canonique pour toutes les opérations. Le bridge attribue un id incrémental à chaque instance qu'il renvoie, dédupe par identité (même instance → même id dans la session). `game` = ref `0`.
- **Path** informatif renvoyé dans chaque `node` (`GetFullName`-like) pour le raisonnement de l'agent. Convenance : `get_by_path(path)` résout un path en ref.
- **Tables faibles côté bridge** :
  - `refToInstance` : `id → Instance`, `__mode = "v"` (valeurs faibles). Une instance détruite et lâchée par le moteur disparaît automatiquement → purge gratuite.
  - `instanceToRef` : `Instance → id`, `__mode = "k"` (clés faibles) pour la dédup sans empêcher le GC.
- **Ref périmée** : à l'usage, `pcall` sur l'accès ; si l'instance n'existe plus → `{ok:false, error:"stale ref N"}`. Jamais de crash.

> Rationale : en Roblox, une instance parentée au DataModel est tenue par le moteur, pas par le GC Lua. Une table à valeurs faibles reste donc valide tant que l'instance est dans l'arbre, et reflète automatiquement les destructions.

## 6. Sérialisation des propriétés — codec JSON taggé

Les types Roblox ne sont pas du JSON natif. Codec partagé : les schémas/types côté TS dans `protocol.ts` (validation seulement) et un encodeur/décodeur Luau dans le bridge (qui fait la conversion réelle Roblox ↔ JSON taggé). Forme : `{ "__t": <type>, …champs }`. Les primitifs (number, string, bool) passent tels quels ; `nil` → `null`.

| Type Roblox | Encodage JSON |
|---|---|
| Vector3 | `{"__t":"Vector3","x":_,"y":_,"z":_}` |
| Vector2 | `{"__t":"Vector2","x":_,"y":_}` |
| CFrame | `{"__t":"CFrame","components":[x,y,z, R00,R01,R02, R10,R11,R12, R20,R21,R22]}` (lossless, `CFrame.new(unpack(components))`) |
| Color3 | `{"__t":"Color3","r":_,"g":_,"b":_}` (0–1) |
| BrickColor | `{"__t":"BrickColor","name":_}` |
| UDim | `{"__t":"UDim","scale":_,"offset":_}` |
| UDim2 | `{"__t":"UDim2","x":{"scale":_,"offset":_},"y":{…}}` |
| EnumItem | `{"__t":"EnumItem","enum":_,"name":_,"value":_}` |
| Instance | `{"__t":"Instance","ref":_,"path":_,"class":_}` |
| NumberSequence / ColorSequence | `{"__t":"…","keypoints":[…]}` |
| (autres non sérialisables) | `{"__t":"Unsupported","repr":tostring(value)}` (lecture seule) |

- **Décodage / coercition** (`setProperty`) : le serveur passe `valueType` (issu de l'API dump). Le bridge accepte la forme taggée *ou* un primitif et coerce selon `valueType`. Ex. `setProperty(ref,"Material","Plastic")` → `Enum.Material.Plastic` ; `setProperty(ref,"Anchored",true)` → bool.
- **`valueType` inconnu** (dump absent et propriété hors set curé) : ordre de repli — (1) si la valeur est taggée (`__t`), décoder par le tag ; (2) sinon, lire le type Lua actuel de `instance[name]` et coercer vers ce type ; (3) sinon, écrire le primitif tel quel. Échec → `{ok:false, error}` explicite.
- `Unsupported` ne peut pas être réécrit ; `setProperty` renvoie une erreur explicite « type non supporté en écriture ».

## 7. API dump (hybride)

- Le **serveur** télécharge l'API dump JSON (source : mirror communautaire `MaximumADHD/Roblox-Client-Tracker`, fichier `API-Dump.json`). Cache dans `~/.cache/dex-mcp/api-dump.json`, TTL ~7 jours, refresh paresseux.
- `api-dump/properties.ts` dérive, par classe (en remontant les superclasses), la liste des propriétés **lisibles, scriptables, non dépréciées**, avec leur `ValueType`.
- Flux `get_properties` :
  1. Le serveur maintient un cache `ref → className` (rempli depuis chaque `node` retourné par get_root/get_children/search).
  2. Cache hit + dump dispo → le serveur envoie `getProperties{ref, propertyNames}` (liste dérivée du dump) en **un aller-retour**.
  3. Cache miss → un aller-retour `getProperties{ref}` (sans noms) qui renvoie `className` + set curé de fallback ; puis enrichissement via dump si souhaité.
- **Fallback** (dump indisponible) : le set curé vit **côté bridge**, pas dans le package serveur. C'est le bridge qui lit les propriétés ; appelé sans `propertyNames`, il renvoie son set curé par classe (propriétés universelles : Name, ClassName, Parent ; + propriétés courantes par classe : Part, Model, Script, GuiObject…). Le serveur, sans dump, relaie simplement ce résultat. Dégradation propre, jamais d'échec dur.

## 8. Surface d'outils MCP (v1)

Tous les outils : schéma d'entrée **Zod**, sortie structurée, erreurs renvoyées comme `{error}` (jamais d'exception remontant à l'agent). Si le bridge est déconnecté → `{error:"bridge not connected"}`.

**Statut**
- `dex_status()` → bridge connecté ?, `gameName`, `placeId`, `clientVersion`, `capabilities`.

**Lecture**
- `get_root()` → ref 0 + services top-level.
- `get_children(ref, classFilter?)` → enfants directs (lazy).
- `get_properties(ref)` → map de propriétés taggées (+ `className`).
- `search(query, root?, classFilter?, limit=100, maxDepth?)` → recherche récursive **plafonnée**.
- `get_source(ref)` → `Source` d'un Script/LocalScript/ModuleScript si lisible.
- `get_by_path(path)` → résout un path en ref.

**Écriture**
- `set_property(ref, name, value)` → coercion via `ValueType` du dump.

**Remotes**
- `fire_remote(ref, args[])` → `FireServer` sur RemoteEvent.
- `invoke_remote(ref, args[])` → `InvokeServer` sur RemoteFunction, renvoie le résultat.
- `remote_spy_start(filter?)` / `remote_spy_stop()` / `remote_spy_dump()` → hook du trafic sortant. **Capability-gated** : si `hookmetamethod`/`getrawmetatable` absents, l'outil renvoie `{error:"remote spy unsupported by this executor"}` au lieu de planter.

**Power**
- `run_luau(code)` → exécute du Luau, renvoie `output` (print capturé) + `returned` (best-effort taggé). **On par défaut** (cf. §10).

### Garde-fous d'échelle

`get_children` et `search` sont **lazy et plafonnés** : jamais de dump récursif complet par défaut (`Workspace` peut dépasser 100k instances). `search` impose `limit` (défaut 100) et un `maxDepth` optionnel. Les nœuds exposent `childCount` pour que l'agent décide d'aller plus loin sans tout charger.

## 9. Sécurité

- WebSocket lié à **`127.0.0.1` uniquement**.
- **Token partagé** généré au démarrage du serveur, imprimé dans les logs, requis dans l'URL (`?token=…`). Le hub rejette toute connexion sans token valide → empêche une page web locale arbitraire de piloter le bridge.
- Flags de config (cf. §10) pour verrouiller les surfaces puissantes au besoin.

## 10. Configuration

Via variables d'environnement et/ou fichier de config, lues par `config.ts` :

| Clé | Défaut | Rôle |
|---|---|---|
| `DEX_MCP_PORT` | `8392` | Port du hub WS |
| `DEX_MCP_TOKEN` | auto-généré | Token partagé |
| `DEX_MCP_ENABLE_WRITE` | `true` | Active `set_property` |
| `DEX_MCP_ENABLE_REMOTES` | `true` | Active fire/invoke/spy |
| `DEX_MCP_ENABLE_RUN_LUAU` | `true` | Active `run_luau` |
| `DEX_MCP_RPC_TIMEOUT_MS` | `15000` | Timeout par requête |

Tous **on par défaut** (c'est un power tool ; token + localhost suffisent). Les flags servent à verrouiller, pas à déverrouiller.

## 11. Layout & tests

```
dex-mcp/
  package.json            # bin: dex-mcp
  tsconfig.json
  src/
    index.ts
    config.ts
    mcp/
      server.ts
      tools/{status,explore,write,remotes,luau}.ts
    protocol.ts
    bridge-hub/
      ws-server.ts
      rpc.ts
    api-dump/
      fetch.ts
      properties.ts
  bridge/
    dex-bridge.luau
  test/
    mock-bridge.ts        # client WS Node simulant le bridge sur un faux arbre
    properties.test.ts
    rpc.test.ts
    tools.test.ts         # end-to-end via mock-bridge
  README.md
  GUIDELINES.md
  LICENSE
```

**Stratégie de test**
- **Mock bridge** : un client WS Node qui simule le bridge Luau face à un faux arbre d'instances → teste tous les outils MCP **end-to-end sans Roblox**. La CI tourne sans executor.
- Unitaires : validation des valeurs taggées (`protocol.ts`, TS), filtrage de propriétés via dump, corrélation/timeout RPC.
- Bridge Luau : maintenu mince ; codec Luau testé via le CLI `luau` si dispo, sinon validation manuelle documentée.

## 12. Futur (hors v1)

- Multi-client (plusieurs bridges, routage par session id).
- Watch/subscribe (notifications de changement de propriété).
- Outils de plus haut niveau (ex. `find_remote_by_name`, diff d'arbre).

## 13. Gouvernance open-source

- **Repository** : https://github.com/972jesko/dex-mcp
- **Licence** : MIT.
- `README.md` : « Intended use » = debug/inspection de ses propres projets Roblox, install du serveur + du bridge.
- `GUIDELINES.md` : cadre l'usage comme outillage de debug et inspection ; le projet n'ajoute pas de features d'évasion et ne les accepte pas en PR.
