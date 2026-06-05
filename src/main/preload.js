const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('scaai', {
  minimize: ()=>ipcRenderer.send('win-minimize'),
  maximize: ()=>ipcRenderer.send('win-maximize'),
  close:    ()=>ipcRenderer.send('win-close'),
  memory:     { load:()=>ipcRenderer.invoke('memory:load'), save:(d)=>ipcRenderer.invoke('memory:save',d), clear:()=>ipcRenderer.invoke('memory:clear') },
  persona:    { load:()=>ipcRenderer.invoke('persona:load'), save:(d)=>ipcRenderer.invoke('persona:save',d) },
  config:     { load:()=>ipcRenderer.invoke('config:load'), save:(d)=>ipcRenderer.invoke('config:save',d) },
  filesIndex: { load:()=>ipcRenderer.invoke('files:load-index'), save:(d)=>ipcRenderer.invoke('files:save-index',d) },
  fs: {
    openFiles:     ()=>ipcRenderer.invoke('fs:open-files'),
    openFolder:    ()=>ipcRenderer.invoke('fs:open-folder'),
    listFolder:    (p)=>ipcRenderer.invoke('fs:list-folder',p),
    readFile:      (p)=>ipcRenderer.invoke('fs:read-file',p),
    readFileChunked: (p,o,l)=>ipcRenderer.invoke('fs:read-file-chunked',p,o,l),
    writeFile:     (p,c)=>ipcRenderer.invoke('fs:write-file',p,c),
    createFile:    (p,c)=>ipcRenderer.invoke('fs:create-file',p,c),
    deleteFile:    (p)=>ipcRenderer.invoke('fs:delete-file',p),
    refreshFile:   (p)=>ipcRenderer.invoke('fs:refresh-file',p),
    refreshFolder: (root)=>ipcRenderer.invoke('fs:refresh-folder',root),
    saveDialog:    (n)=>ipcRenderer.invoke('fs:save-dialog',n),
    openExternal:  (p)=>ipcRenderer.invoke('fs:open-external',p),
    stat:          (p)=>ipcRenderer.invoke('fs:stat',p),
    // ── Upgrade 1: Disk Awareness ──
    diskScan:      (roots)=>ipcRenderer.invoke('fs:disk-scan',roots),
    diskIndex:     ()=>ipcRenderer.invoke('fs:disk-index'),
    diskWatch:     (paths)=>ipcRenderer.invoke('fs:disk-watch',paths),
    diskUnwatch:   ()=>ipcRenderer.invoke('fs:disk-unwatch'),
    onDiskChanged: (cb)=>ipcRenderer.on('fs:disk-changed',(_,d)=>cb(d)),
    onDiskReady:   (cb)=>ipcRenderer.on('fs:disk-ready',  (_,d)=>cb(d)),
    // ── Upgrade 3: Index Query API ──
    diskExtSummary: ()    => ipcRenderer.invoke('fs:disk-ext-summary'),
    diskQueryExt:   (ext) => ipcRenderer.invoke('fs:disk-query-ext', ext),
  },
  sys: {
    info:     ()=>ipcRenderer.invoke('sys:info'),
    exec:     (cmd,opts)=>ipcRenderer.invoke('sys:exec',cmd,opts),
    listDir:  (p)=>ipcRenderer.invoke('sys:list-dir',p),
    find:     (root,pat)=>ipcRenderer.invoke('sys:find',root,pat),
    openUrl:  (url)=>ipcRenderer.invoke('sys:open-url',url),
    openPath: (p)=>ipcRenderer.invoke('sys:open-path',p),
    ui:       (script,opts)=>ipcRenderer.invoke('sys:ui',script,opts),
    selfMap:  ()=>ipcRenderer.invoke('sys:self-map'),
  },
  api: { chat:(opts)=>ipcRenderer.invoke('api:chat',opts) },
  // ── WSL2 integration ──
  wsl2: {
    status:    ()        => ipcRenderer.invoke('wsl2:status'),
    winToWsl:  (p)       => ipcRenderer.invoke('wsl2:win-to-wsl', p),
    wslToWin:  (p)       => ipcRenderer.invoke('wsl2:wsl-to-win', p),
    onReady:   (cb)      => ipcRenderer.on('wsl2:ready', (_, d) => cb(d)),
  },
  feedback: {
    save: (entry)=>ipcRenderer.invoke('feedback:save',entry),
    load: ()=>ipcRenderer.invoke('feedback:load'),
  },
  threads: {
    save:   (entry)=>ipcRenderer.invoke('threads:save',entry),
    load:   ()=>ipcRenderer.invoke('threads:load'),
    delete: (id)=>ipcRenderer.invoke('threads:delete',id),
  },
  profile: {
    load:        ()=>ipcRenderer.invoke('profile:load'),
    save:        (d)=>ipcRenderer.invoke('profile:save',d),
    updateField: (k,v)=>ipcRenderer.invoke('profile:update-field',k,v),
  },
  tools: {
    load: ()=>ipcRenderer.invoke('tools:load'),
    save: (d)=>ipcRenderer.invoke('tools:save',d),
  },
  // ── Projects ──
  projects: {
    load:   ()       => ipcRenderer.invoke('projects:load'),
    create: (d)      => ipcRenderer.invoke('projects:create',d),
    update: (id,d)   => ipcRenderer.invoke('projects:update',id,d),
    delete: (id)     => ipcRenderer.invoke('projects:delete',id),
    rename: (id,nm)  => ipcRenderer.invoke('projects:rename',id,nm),
  },
  // ── Chat History ──
  chats: {
    load:          ()         => ipcRenderer.invoke('chats:load'),
    save:          (d)        => ipcRenderer.invoke('chats:save',d),
    delete:        (id)       => ipcRenderer.invoke('chats:delete',id),
    rename:        (id,nm)    => ipcRenderer.invoke('chats:rename',id,nm),
    loadByProject: (pid)      => ipcRenderer.invoke('chats:load-by-project',pid),
  },
  web: {
    search: (opts)=>ipcRenderer.invoke('api:web-search',opts),
  },
  // ── Semantic Memory ──
  sem: {
    init:    ()          => ipcRenderer.invoke('sem:init'),
    search:  (args)      => ipcRenderer.invoke('sem:search',  args),
    store:   (args)      => ipcRenderer.invoke('sem:store',   args),
    stats:   ()          => ipcRenderer.invoke('sem:stats'),
    install: ()          => ipcRenderer.invoke('sem:install'),
    recall:  (args)      => ipcRenderer.invoke('sem:recall',  args),
    learn:   (args)      => ipcRenderer.invoke('sem:learn',   args),
    forget:  (args)      => ipcRenderer.invoke('sem:forget',  args),
    listAll:  (args)      => ipcRenderer.invoke('sem:list_all',args||{}),
    ingest:   (args)      => ipcRenderer.invoke('sem:ingest',  args||{}),
    diagnose: ()          => ipcRenderer.invoke('sem:diagnose'),
    context:  (args)      => ipcRenderer.invoke('sem:context', args||{}),
    profile:  ()          => ipcRenderer.invoke('sem:profile'),
    recallByDate: (args)  => ipcRenderer.invoke('sem:recall_by_date', args||{}),
    analyze:      (args)  => ipcRenderer.invoke('sem:analyze',       args||{}),
    deepAnalyze:         (args) => ipcRenderer.invoke('sem:deep_analyze',          args||{}),
    embeddingCheck:      ()     => ipcRenderer.invoke('sem:embedding_check'),
    health:              ()     => ipcRenderer.invoke('sem:health'),
    prune:               (args) => ipcRenderer.invoke('sem:prune',                  args||{}),
    importConversations: (args) => ipcRenderer.invoke('sem:import_conversations',   args||{}),
    topics:              (args) => ipcRenderer.invoke('sem:topics',                 args||{}),
    score:               (args) => ipcRenderer.invoke('sem:score',                  args||{}),
    graphStore:          (args) => ipcRenderer.invoke('sem:graph_store',            args||{}),
    graphQuery:          (args) => ipcRenderer.invoke('sem:graph_query',            args||{}),
    graphAll:            ()     => ipcRenderer.invoke('sem:graph_all'),
    // ── Algorithmic Graph Intelligence ──
    graphCentrality:     (args) => ipcRenderer.invoke('sem:graph_centrality',  args||{}),
    graphCluster:        (args) => ipcRenderer.invoke('sem:graph_cluster',     args||{}),
    graphDecay:          (args) => ipcRenderer.invoke('sem:graph_decay',       args||{}),
    graphBoost:          (args) => ipcRenderer.invoke('sem:graph_boost',       args||{}),
    graphTraverse:       (args) => ipcRenderer.invoke('sem:graph_traverse',    args||{}),
  },
  // ── Upgrade 2: Skills ──
  skills: {
    list:     ()              => ipcRenderer.invoke('skills:list'),
    run:      (id,args)       => ipcRenderer.invoke('skills:run',    id, args),
    openDir:  ()              => ipcRenderer.invoke('skills:open-dir'),
    install:  (payload)       => ipcRenderer.invoke('skills:install', payload),
    delete:   (id)            => ipcRenderer.invoke('skills:delete',  id),
  },
  // ── Upgrade 2: Agents ──
  agents: {
    load:   ()         => ipcRenderer.invoke('agents:load'),
    get:    (id)       => ipcRenderer.invoke('agents:get',    id),
    create: (data)     => ipcRenderer.invoke('agents:create', data),
    update: (id,data)  => ipcRenderer.invoke('agents:update', id, data),
    delete: (id)       => ipcRenderer.invoke('agents:delete', id),
    chat:   (opts)     => ipcRenderer.invoke('agents:chat',   opts),
  },
  // ── MCP (Model Context Protocol) ──
  mcp: {
    start:      (opts) => ipcRenderer.invoke('mcp:start', opts),
    stop:       (id)   => ipcRenderer.invoke('mcp:stop',  id),
    list:       ()     => ipcRenderer.invoke('mcp:list'),
    loadConfig: ()     => ipcRenderer.invoke('mcp:loadConfig'),
    saveConfig: (s)   => ipcRenderer.invoke('mcp:saveConfig', s),
  },
  // ── Attachment Cache ──
  attachments: {
    save:        (d) => ipcRenderer.invoke('attachments:save', d),
    read:        (d) => ipcRenderer.invoke('attachments:read', d),
    readBulk:    (d) => ipcRenderer.invoke('attachments:readBulk', d),
    deleteForChat: (d) => ipcRenderer.invoke('attachments:deleteForChat', d),
    gc:          ()  => ipcRenderer.invoke('attachments:gc'),
  },
  // ── Clipboard ──
  clipboard: {
    readImage: () => ipcRenderer.invoke('clipboard:read-image'),
  },
  // ── Groq Audio (Whisper STT + Orpheus TTS) ──
  audio: {
    transcribe: (opts) => ipcRenderer.invoke('audio:transcribe', opts),
    polish:     (opts) => ipcRenderer.invoke('audio:polish',     opts),
    speak:      (opts) => ipcRenderer.invoke('audio:speak',      opts),
  },
  // ── RAG XAI (Transparency Panel) ──
  rag: {
    explain:    (opts) => ipcRenderer.invoke('rag:explain',     opts),
    xaiHistory: (opts) => ipcRenderer.invoke('rag:xai-history', opts||{}),
  },
});