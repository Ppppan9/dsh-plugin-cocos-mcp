'use strict';

/**
 * 面板 → 扩展主进程 的调用封装。
 * 面板跑在渲染进程，扩展主进程的方法要通过 Editor.Message 跨进程调。
 */

const PKG = 'cocos-mcp';

async function getStatus() {
    return await Editor.Message.request(PKG, 'getBridgeStatus');
}

async function getClientConfig() {
    const r = await Editor.Message.request(PKG, 'copyClientConfig');
    return r && r.config ? r.config : '';
}

async function copyClientConfig() {
    return await Editor.Message.request(PKG, 'copyClientConfig');
}

async function restart() {
    return await Editor.Message.request(PKG, 'restartBridge');
}

async function getChannels() {
    // 频道清单是静态的（编译期固化），渲染进程直接取快照即可，不必跨进程问主进程。
    return require('../bridge/messages.js').listChannels();
}

module.exports = { api: { getStatus, getClientConfig, copyClientConfig, restart, getChannels } };
