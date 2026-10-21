'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 路径护栏的公共实现
 * ---------------------------------------------------------------------------
 * hub 侧（global-tools.js）与离线模块侧（offline/ops.js）都要用同一套判断 ——
 * 之前两边各写各的，导致「同一个软链路径在 cocos_prefab_edit 被拦、
 * 在 cocos_prefab_batch 却放行」。
 */

/**
 * 求「尽可能真实」的路径：把已存在的部分逐段 realpath 掉，不存在的尾部按字面拼上。
 *
 * 为什么需要：path.resolve 只做**词法**折叠，符号链接原样保留。
 * 项目里放一个 `assets_link -> ~/.ssh` 的软链，词法判断会认为
 * `<项目>/assets_link/id_rsa` 在项目内 → 实际读的是项目外。
 */
function realpathBestEffort(target) {
    const abs = path.resolve(target);
    const parts = abs.split(path.sep);
    let cur = parts[0] === '' ? path.sep : parts[0];
    const trailing = [];
    for (let i = 1; i < parts.length; i++) {
        const next = path.join(cur, parts[i]);
        try {
            cur = fs.realpathSync(next);
        } catch (_) {
            // 这一段不存在（或没权限），后面的按字面拼
            cur = next;
            trailing.length = 0;
            for (let j = i + 1; j < parts.length; j++) trailing.push(parts[j]);
            break;
        }
    }
    return trailing.length ? path.join(cur, ...trailing) : cur;
}

/**
 * 判断 target 是否落在 roots 之内（词法 + 真实路径双判）。
 * @param {string} target
 * @param {string[]} roots
 * @returns {boolean}
 */
function isInsideAnyRoot(target, roots) {
    if (!Array.isArray(roots) || !roots.length) return false;
    const realTarget = realpathBestEffort(target);
    for (const root of roots) {
        const realRoot = realpathBestEffort(root);
        const rel = path.relative(realRoot, realTarget);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    }
    return false;
}

module.exports = { realpathBestEffort, isInsideAnyRoot };
