'use strict';

/**
 * Cocos Creator 3.8.x 编辑器消息白名单
 * ---------------------------------------------------------------------------
 * 为什么要这份白名单？
 *
 * 现存的开源 Cocos MCP 实现里，harady/cocos-creator-mcp 有 10 个
 * `scene:add-reference-image` 之类的消息名在 3.8.8 里根本不存在 ——
 * 工具注册成功，但一调用就报错，agent 会白白烧掉好几轮 token。
 *
 * 所以我们把「经 3.8.8 真机包体交叉验证确实存在」的编辑器消息固化成白名单，
 * Bridge 在转发前逐条校验。**不在白名单里的消息一律拒绝并给出替代方案**，
 * 绝不把一个注定失败的调用丢给编辑器。
 *
 * 数据来源：
 *   1. @cocos/creator-types 官方类型契约（Cocos Creator 3.8.8 随包发布）
 *      - packages/scene/@types/message.d.ts
 *      - packages/asset-db/@types/message.d.ts
 *      - packages/preview/@types/protected/message.d.ts
 *      - packages/builder/@types/message.d.ts
 *   2. 对 app.asar 做全量字节扫描，确认字符串确实存在于 3.8.8 二进制中。
 */

/**
 * 每个消息的描述：
 *   params  —— 位置参数个数（0 表示无参）
 *   shape   —— 参数形状提示，用于把人话参数翻译成编辑器要的形状
 *   readonly—— 是否只读（只读工具不需要二次确认）
 */
const CHANNELS = {
    scene: {
        'open-scene': { params: 1, shape: 'string(uuid)', readonly: true },
        'save-scene': { params: 0, shape: 'optional boolean', readonly: false },
        'save-as-scene': { params: 0, readonly: false },
        'close-scene': { params: 0, readonly: false },
        'set-property': { params: 1, shape: 'SetPropertyOptions {uuid,path,dump}', readonly: false },
        'reset-property': { params: 1, shape: 'SetPropertyOptions', readonly: false },
        'move-array-element': { params: 1, shape: 'MoveArrayOptions {uuid,path,target,offset}', readonly: false },
        'remove-array-element': { params: 1, shape: 'RemoveArrayOptions {uuid,path,index}', readonly: false },
        'copy-node': { params: 1, shape: 'string | string[]', readonly: false },
        'duplicate-node': { params: 1, shape: 'string | string[]', readonly: false },
        'paste-node': { params: 1, shape: 'PasteNodeOptions {target,uuids,keepWorldTransform?,pasteAsChild?}', readonly: false },
        'cut-node': { params: 1, shape: 'CutNodeOptions {parent,uuids,keepWorldTransform?}', readonly: false },
        'set-parent': { params: 1, shape: 'CutNodeOptions {parent,uuids}', readonly: false },
        'create-node': { params: 1, shape: 'CreateNodeOptions {parent?,name?,type?,position?,assetUuid?,canvasRequired?}', readonly: false },
        'remove-node': { params: 1, shape: 'RemoveNodeOptions {uuid,keepWorldTransform?}', readonly: false },
        'reset-node': { params: 1, shape: 'ResetNodeOptions {uuid}', readonly: false },
        'reset-component': { params: 1, shape: 'ResetComponentOptions {uuid,component}', readonly: false },
        'restore-prefab': { params: 1, shape: 'ResetComponentOptions {uuid,component}', readonly: false },
        'create-component': { params: 1, shape: 'CreateComponentOptions {uuid,component}', readonly: false },
        'remove-component': { params: 1, shape: 'RemoveComponentOptions {uuid,component}', readonly: false },
        'execute-component-method': { params: 1, shape: 'ExecuteComponentMethodOptions {uuid,name,args?}', readonly: false },
        'execute-scene-script': { params: 1, shape: 'ExecuteSceneScriptMethodOptions {name,method,args?}', readonly: false },
        snapshot: { params: 0, readonly: false, desc: 'Snapshot current scene state（官方描述：快照当前场景状态）' },
        'snapshot-abort': { params: 0, readonly: false, desc: 'Abort snapshot（官方描述：中止快照）' },
        // undo 录制原语。官方 i18n 描述表里明确写着
        //   begin_recording: "Begin node recording for undo"
        //   end_recording:   "End node recording for undo"
        //   cancel_recording:"Cancel node recording for undo"
        // —— 这才是真正的「多步操作失败可回滚」机制。
        'begin-recording': { params: 0, readonly: false, desc: 'Begin node recording for undo' },
        'end-recording': { params: 0, readonly: false, desc: 'End node recording for undo' },
        'cancel-recording': { params: 0, readonly: false, desc: 'Cancel node recording for undo' },
        'soft-reload': { params: 0, readonly: false },
        'change-gizmo-tool': { params: 1, shape: 'string', readonly: false },
        'query-gizmo-tool-name': { params: 0, readonly: true },
        'change-gizmo-pivot': { params: 1, shape: 'string', readonly: false },
        'query-gizmo-pivot': { params: 0, readonly: true },
        'change-gizmo-coordinate': { params: 1, shape: 'string', readonly: false },
        'query-gizmo-coordinate': { params: 0, readonly: true },
        'change-is2D': { params: 1, shape: 'boolean', readonly: false },
        'query-is2D': { params: 0, readonly: true },
        'set-grid-visible': { params: 1, shape: 'boolean', readonly: false },
        'query-is-grid-visible': { params: 0, readonly: true },
        'set-icon-gizmo-3d': { params: 1, shape: 'boolean', readonly: false },
        'query-is-icon-gizmo-3d': { params: 0, readonly: true },
        'set-icon-gizmo-size': { params: 1, shape: 'number', readonly: false },
        'query-icon-gizmo-size': { params: 0, readonly: true },
        'focus-camera': { params: 1, shape: 'string[]', readonly: false },
        'align-with-view': { params: 0, readonly: false },
        'align-view-with-node': { params: 0, readonly: false },
        'query-is-ready': { params: 0, readonly: true },
        'query-node': { params: 1, shape: 'string(uuid)', readonly: true },
        'query-component': { params: 1, shape: 'string(uuid)', readonly: true },
        'query-node-tree': { params: 1, shape: 'optional string(uuid)', readonly: true },
        'query-nodes-by-asset-uuid': { params: 1, shape: 'string(uuid)', readonly: true },
        'query-dirty': { params: 0, readonly: true },
        'query-classes': { params: 1, shape: 'QueryClassesOptions', readonly: true },
        'query-components': { params: 0, readonly: true },
        'query-component-has-script': { params: 1, shape: 'string(uuid)', readonly: true },
        'query-scene-bounds': { params: 0, readonly: true },
        'is-native': { params: 1, shape: 'optional {checkAvailable?}', readonly: true },
    },

    'asset-db': {
        'query-ready': { params: 0, readonly: true },
        'create-asset': { params: 2, shape: 'url, content|null, options?', readonly: false },
        'import-asset': { params: 2, shape: 'url, content, options?', readonly: false },
        'copy-asset': { params: 2, shape: 'src, dst, options?', readonly: false },
        'move-asset': { params: 2, shape: 'src, dst, options?', readonly: false },
        'delete-asset': { params: 1, shape: 'url', readonly: false },
        'open-asset': { params: 1, shape: 'url', readonly: false },
        'save-asset': { params: 2, shape: 'url, content', readonly: false },
        'save-asset-meta': { params: 2, shape: 'url, content', readonly: false },
        'reimport-asset': { params: 1, shape: 'url', readonly: false },
        'refresh-asset': { params: 1, shape: 'url', readonly: false },
        'query-asset-info': { params: 2, shape: 'urlOrUuidOrPath, dataKeys?', readonly: true },
        'query-missing-asset-info': { params: 1, shape: 'urlOrPath', readonly: true },
        'query-asset-meta': { params: 1, shape: 'uuid', readonly: true },
        'query-asset-users': { params: 2, shape: 'uuidOrUrl, type?', readonly: true },
        'query-asset-dependencies': { params: 2, shape: 'uuidOrUrl, type?', readonly: true },
        'query-path': { params: 1, shape: 'url', readonly: true },
        'query-url': { params: 1, shape: 'uuid', readonly: true },
        'query-uuid': { params: 1, shape: 'url', readonly: true },
        'query-assets': { params: 2, shape: 'options?, dataKeys?', readonly: true },
        'generate-available-url': { params: 1, shape: 'url', readonly: true },
    },

    preview: {
        'query-preview-url': { params: 0, readonly: true },
        'generate-settings': { params: 0, readonly: true },
    },

    builder: {
        open: { params: 2, shape: 'panel, options?', readonly: false },
        'query-worker-ready': { params: 0, readonly: true },
        'query-tasks-info': { params: 1, shape: '{type,sortType?}', readonly: true },
        'query-task': { params: 1, shape: 'id', readonly: true },
        'add-task': { params: 2, shape: 'options, shouldWait?', readonly: false },
        'query-platform-config': { params: 1, shape: 'platform', readonly: true },
    },

    preferences: {
        'open-settings': { params: 1, shape: 'name', readonly: false },
        'query-config': { params: 3, shape: 'name, key?, protocol?', readonly: true },
        'set-config': { params: 4, shape: 'name, key, value, protocol?', readonly: false },
    },

    project: {
        'query-config': { params: 1, shape: 'key', readonly: true },
        'set-config': { params: 2, shape: 'key, value', readonly: false },
        'open-settings': { params: 1, shape: 'name', readonly: false },
    },

    program: {
        'query-program-info': { params: 1, shape: 'path', readonly: true },
        'open-program': { params: 2, shape: 'path, options?', readonly: false },
        'open-url': { params: 2, shape: 'url, options?', readonly: false },
    },

    programming: {
        'query-shared-settings': { params: 0, readonly: true },
        'query-sorted-plugins': { params: 1, shape: 'options?', readonly: true },
    },

    engine: {
        'query-info': { params: 1, shape: 'optional path', readonly: true },
        'query-engine-info': { params: 1, shape: 'optional path', readonly: true },
    },

    server: {
        'query-ip-list': { params: 0, readonly: true },
        'query-port': { params: 0, readonly: true },
        'query-sort-ip-list': { params: 0, readonly: true },
    },

    information: {
        'query-information': { params: 2, shape: 'tag, options?', readonly: true },
        'has-dialog': { params: 1, shape: 'tag', readonly: true },
        'close-dialog': { params: 1, shape: 'tag', readonly: false },
    },

    device: {
        query: { params: 0, readonly: true },
    },

    extension: {
        'create-extension-template': { params: 2, readonly: false },
    },

    console: {
        clear: { params: 0, readonly: false },
    },
};

/**
 * `reference-image` 不是 Cocos 内置频道，而是编辑器扩展
 * （/modules/editor-extensions/extensions/reference-image）。
 * 但它确实注册了自己的消息，且官方 i18n 文档里有完整说明，所以单列一档。
 * 注意：harady 实现用的是 `scene:add-reference-image` 这类错误名字，
 * 正确的是 `reference-image:add-image`。
 */
const REFERENCE_IMAGE = {
    'add-image': { params: 1, shape: 'string[] (文件路径)', readonly: false },
    'remove-image': { params: 1, shape: 'string[]?', readonly: false },
    'switch-image': { params: 2, shape: 'path, specifySceneUUID?', readonly: false },
    'set-image-data': { params: 2, shape: 'key(path|x|y|sx|sy|opacity), value', readonly: false },
    'query-config': { params: 0, readonly: true },
    'query-current': { params: 0, readonly: true },
    refresh: { params: 0, readonly: false },
};

/**
 * 在已知存在但被识别为「不存在」的历史错误名 → 正确名 的映射。
 * 存在的意义：agent 如果照着旧教程调用，我们给出精准纠错而不是一句 not found。
 */
const ALIASES = {
    'scene:add-reference-image': 'reference-image:add-image',
    'scene:remove-reference-image': 'reference-image:remove-image',
    'scene:switch-reference-image': 'reference-image:switch-image',
    'scene:refresh-reference-image': 'reference-image:refresh',
    'scene:query-reference-image-config': 'reference-image:query-config',
    'scene:query-current-reference-image': 'reference-image:query-current',
    'scene:set-reference-image-position': 'reference-image:set-image-data',
    'scene:set-reference-image-scale': 'reference-image:set-image-data',
    'scene:set-reference-image-opacity': 'reference-image:set-image-data',
    'scene:clear-all-reference-images': 'reference-image:remove-image',
    'scene:query-grid-visible': 'scene:query-is-grid-visible',
    'scene:query-is-dirty': 'scene:query-dirty',
    'scene:query-node-by-asset-uuid': 'scene:query-nodes-by-asset-uuid',
    'asset-db:query-asset-depends': 'asset-db:query-asset-dependencies',
    'asset-db:query-depends': 'asset-db:query-asset-dependencies',
};

/** 白名单里明确「3.8.8 不存在」的调用点，命中时给出说明而不是裸报错。 */
const KNOWN_MISSING = {
    'scene:query-performance': '3.8.8 没有场景性能查询消息。请改用 Cocos 预览页的性能面板，或用 preview 工具采集运行时数据。',
    'scene:query-hierarchy': '3.8.8 没有该消息。请用 scene:query-node-tree。',
    'scene:check-missing-assets': '3.8.8 没有该消息。请用 asset-db:query-missing-asset-info。',
    'scene:apply-prefab-link': '3.8.8 没有该消息。请用 scene:restore-prefab 或 prefab 域工具。',
    'scene:connect-prefab-instance': '3.8.8 没有该消息。请用 scene:restore-prefab。',
    'scene:set-prefab': '3.8.8 没有该消息。请用 scene:restore-prefab。',
    'scene:set-prefab-connection': '3.8.8 没有该消息。请用 scene:restore-prefab。',
    'scene:load-prefab-to-node': '3.8.8 没有该消息。请用 asset-db:open-asset 打开 prefab。',
    'scene:delete-component': '3.8.8 没有该消息。删除组件请用 scene:remove-component。',
    'scene:undo.record': '3.8.8 没有该消息。请用 scene:snapshot / scene:snapshot-abort。',
    'scene:new-scene': '3.8.8 没有该消息。请用 asset-db:create-asset 创建 .scene 后再 scene:open-scene。',
    'scene:revert-prefab': '3.8.8 没有该消息。请用 scene:restore-prefab。',
    'scene:change-view-mode-2d-3d': '3.8.8 没有该消息。请用 scene:change-is2D。',
    'scene:query-view-mode-2d-3d': '3.8.8 没有该消息。请用 scene:query-is2D。',
    'scene:reset-scene-view': '3.8.8 没有该消息。',
    'console:query-last-logs': '3.8.8 没有该消息。',
    'builder:query-build-options': '3.8.8 没有该消息。请用 builder:query-platform-config。',
    'asset-db:open-asset-external': '3.8.8 没有该消息。',
    'asset-db:write-asset': '3.8.8 没有该消息。请用 asset-db:save-asset。',
};

function describe(channel, message) {
    if (channel === 'reference-image') {
        return REFERENCE_IMAGE[message] || null;
    }
    const ch = CHANNELS[channel];
    if (!ch) return null;
    return ch[message] || null;
}

/**
 * 校验一个编辑器消息调用是否合法。
 * @returns {{ok:true, readonly:boolean}|{ok:false, reason:string, suggestion?:string}}
 */
function verify(channel, message) {
    const full = `${channel}:${message}`;
    const desc = describe(channel, message);
    if (desc) {
        return { ok: true, readonly: !!desc.readonly };
    }
    if (ALIASES[full]) {
        return {
            ok: false,
            reason: `编辑器消息 "${full}" 在 Cocos Creator 3.8.8 中不存在。`,
            suggestion: `请改用 "${ALIASES[full]}"。`,
        };
    }
    if (KNOWN_MISSING[full]) {
        return { ok: false, reason: `编辑器消息 "${full}" 在 Cocos Creator 3.8.8 中不存在。`, suggestion: KNOWN_MISSING[full] };
    }
    const known = CHANNELS[channel] ? Object.keys(CHANNELS[channel]) : [];
    const near = known.filter((m) => m.includes(message) || message.includes(m)).slice(0, 5);
    return {
        ok: false,
        reason: `编辑器消息 "${full}" 不在 Cocos Creator 3.8.8 的已验证白名单中，拒绝转发（避免必然失败的调用）。`,
        suggestion: near.length
            ? `你是不是想用：${near.map((m) => `"${channel}:${m}"`).join('、')} ？`
            : `可用频道：${Object.keys(CHANNELS).join('、')}、reference-image`,
    };
}

function listChannels() {
    const out = {};
    for (const [ch, msgs] of Object.entries(CHANNELS)) {
        out[ch] = Object.keys(msgs);
    }
    out['reference-image'] = Object.keys(REFERENCE_IMAGE);
    return out;
}

module.exports = { CHANNELS, REFERENCE_IMAGE, ALIASES, KNOWN_MISSING, verify, describe, listChannels };
