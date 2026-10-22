'use strict';

/**
 * 扩展端 `extension/scene.js` 的单元测试（用假 cc 驱动**真实实现**）
 * ---------------------------------------------------------------------------
 * 为什么需要：scene.js 是 `scene.script` 走的**引擎级**实现，
 * 此前只有 e2e 覆盖（要开着 Cocos Creator），CI 上没有回归保护。
 *
 * 重点是**原型链**：
 *   `setNodeProperty(uuid, '__proto__.toString', 'PWNED')`
 *   → 会把 `Object.prototype.toString` 覆盖成字符串
 *   → **整个编辑器进程的原型被破坏**（模板字符串、String(obj) 全废）。
 *   原因：那句「属性必须存在」用的是 `key in obj`，而 `in` 会走原型链。
 *
 * 运行：node --test hub/test/extension-scene.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const SCENE = path.join(__dirname, '../../extension/scene.js');

/** 装一个假的 cc 模块，并加载真实的 scene.js。 */
function loadSceneJs() {
    const fakeNode = { name: 'Root', components: [], parent: null };
    class Vec3 {
        constructor() { this.x = 0; this.y = 0; this.z = 0; }
    }
    const fakeCC = {
        find: (uuid) => (uuid === 'node-1' ? fakeNode : null),
        Node: class { constructor(n) { this.name = n; this.components = []; this.parent = null; } },
        UITransform: class {},
        Vec3,
        Vec2: class { constructor() { this.x = 0; this.y = 0; } },
        Vec4: class { constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 0; } },
        Quat: class { constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; } },
        Color: class { constructor() { this.r = 0; this.g = 0; this.b = 0; this.a = 255; } },
        Size: class { constructor() { this.width = 0; this.height = 0; } },
        director: { getScene: () => null },
    };

    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...args) {
        if (request === 'cc') return 'fake-cc';
        return origResolve.call(this, request, ...args);
    };
    const prevFake = require.cache['fake-cc'];
    require.cache['fake-cc'] = { id: 'fake-cc', filename: 'fake-cc', loaded: true, exports: fakeCC };
    // 清掉 scene.js 的缓存，确保它拿到刚装好的假 cc
    const prevScene = require.cache[require.resolve(SCENE)];
    delete require.cache[require.resolve(SCENE)];
    const mod = require(SCENE);

    // ⚠️ 桩要**一直有效到用例结束** ——
    //    scene.js 里的 `require('cc')` 是在**方法体里**惰性调用的，
    //    加载完就还原的话，方法一跑就找不到 'cc' 了。
    function restore() {
        Module._resolveFilename = origResolve;
        if (prevFake) require.cache['fake-cc'] = prevFake;
        else delete require.cache['fake-cc'];
        if (prevScene) require.cache[require.resolve(SCENE)] = prevScene;
    }
    return { methods: mod.methods, node: fakeNode, Vec3, restore };
}

test('★ setNodeProperty：正常设属性能用', () => {
    const { methods, node, Vec3, restore } = loadSceneJs();
    try {
        node.position = new Vec3();
        node.position.x = 1;
        const r = methods.setNodeProperty('node-1', 'position', { x: 9, y: 8, z: 7 });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(node.position.x, 9);
        assert.strictEqual(node.position.z, 7);
    } finally {
        restore();
    }
});

test('★ setNodeProperty：原型链段名必须被拒（否则能污染整个编辑器进程）', () => {
    const { methods, restore } = loadSceneJs();
    const before = Object.prototype.toString;
    try {
        for (const path of ['__proto__.toString', '__proto__', 'constructor', 'prototype', '__proto__.polluted']) {
            assert.throws(
                () => methods.setNodeProperty('node-1', path, 'PWNED'),
                /保留段/,
                `path="${path}" 必须被拒绝`
            );
        }
        // ★ 最关键：全局原型必须**一点没变**
        assert.strictEqual(Object.prototype.toString, before, '★ Object.prototype 被污染了');
        assert.strictEqual(({}).polluted, undefined, '★ Object.prototype 上多了键');
    } finally {
        restore();
    }
});

test('★ setNodeProperty：给不存在且不在原型上的属性要报错（不能静默新建）', () => {
    const { methods, restore } = loadSceneJs();
    try {
        assert.throws(
            () => methods.setNodeProperty('node-1', 'definitelyNotAProperty', 1),
            /不存在/,
            '★ 不该凭空造一个属性'
        );
    } finally {
        restore();
    }
});
