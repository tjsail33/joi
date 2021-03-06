'use strict';

// Load modules

const Hoek = require('hoek');
const Topo = require('topo');
const Any = require('./any');
const Cast = require('./cast');


// Declare internals

const internals = {};


internals.Object = function () {

    Any.call(this);
    this._type = 'object';
    this._inner.children = null;
    this._inner.renames = [];
    this._inner.dependencies = [];
    this._inner.patterns = [];
};

Hoek.inherits(internals.Object, Any);


internals.Object.prototype._base = function (value, state, options) {

    let target = value;
    const errors = [];
    const finish = () => {

        return {
            value: target,
            errors: errors.length ? errors : null
        };
    };

    if (typeof value === 'string' &&
        options.convert) {

        try {
            value = JSON.parse(value);
        }
        catch (parseErr) { }
    }

    const type = this._flags.func ? 'function' : 'object';
    if (!value ||
        typeof value !== type ||
        Array.isArray(value)) {

        errors.push(this.createError(type + '.base', null, state, options));
        return finish();
    }

    // Skip if there are no other rules to test

    if (!this._inner.renames.length &&
        !this._inner.dependencies.length &&
        !this._inner.children &&                    // null allows any keys
        !this._inner.patterns.length) {

        target = value;
        return finish();
    }

    // Ensure target is a local copy (parsed) or shallow copy

    if (target === value) {
        if (type === 'object') {
            target = Object.create(Object.getPrototypeOf(value));
        }
        else {
            target = function () {

                return value.apply(this, arguments);
            };

            target.prototype = Hoek.clone(value.prototype);
        }

        const valueKeys = Object.keys(value);
        for (let i = 0; i < valueKeys.length; ++i) {
            target[valueKeys[i]] = value[valueKeys[i]];
        }
    }
    else {
        target = value;
    }

    // Rename keys

    const renamed = {};
    for (let i = 0; i < this._inner.renames.length; ++i) {
        const item = this._inner.renames[i];

        if (item.options.ignoreUndefined && target[item.from] === undefined) {
            continue;
        }

        if (!item.options.multiple &&
            renamed[item.to]) {

            errors.push(this.createError('object.rename.multiple', { from: item.from, to: item.to }, state, options));
            if (options.abortEarly) {
                return finish();
            }
        }

        if (Object.prototype.hasOwnProperty.call(target, item.to) &&
            !item.options.override &&
            !renamed[item.to]) {

            errors.push(this.createError('object.rename.override', { from: item.from, to: item.to }, state, options));
            if (options.abortEarly) {
                return finish();
            }
        }

        if (target[item.from] === undefined) {
            delete target[item.to];
        }
        else {
            target[item.to] = target[item.from];
        }

        renamed[item.to] = true;

        if (!item.options.alias) {
            delete target[item.from];
        }
    }

    // Validate schema

    if (!this._inner.children &&            // null allows any keys
        !this._inner.patterns.length &&
        !this._inner.dependencies.length) {

        return finish();
    }

    const unprocessed = Hoek.mapToObject(Object.keys(target));

    // Children mustn't inherit the current label if it exists
    const childOptions = options.language && options.language.label ?
        Hoek.applyToDefaults(options, { language: { label: null } }, true) :
        options;

    if (this._inner.children) {
        for (let i = 0; i < this._inner.children.length; ++i) {
            const child = this._inner.children[i];
            const key = child.key;
            const item = target[key];

            delete unprocessed[key];

            const localState = { key, path: (state.path || '') + (state.path && key ? '.' : '') + key, parent: target, reference: state.reference };
            const result = child.schema._validate(item, localState, childOptions);
            if (result.errors) {
                errors.push(this.createError('object.child', { key, reason: result.errors }, localState, childOptions));

                if (options.abortEarly) {
                    return finish();
                }
            }

            if (child.schema._flags.strip || (result.value === undefined && result.value !== item)) {
                delete target[key];
            }
            else if (result.value !== undefined) {
                target[key] = result.value;
            }
        }
    }

    // Unknown keys

    let unprocessedKeys = Object.keys(unprocessed);
    if (unprocessedKeys.length &&
        this._inner.patterns.length) {

        for (let i = 0; i < unprocessedKeys.length; ++i) {
            const key = unprocessedKeys[i];

            for (let j = 0; j < this._inner.patterns.length; ++j) {
                const pattern = this._inner.patterns[j];

                if (pattern.regex.test(key)) {
                    delete unprocessed[key];

                    const item = target[key];
                    const localState = { key, path: (state.path ? state.path + '.' : '') + key, parent: target, reference: state.reference };
                    const result = pattern.rule._validate(item, localState, options);
                    if (result.errors) {
                        errors.push(this.createError('object.child', { key, reason: result.errors }, localState, options));

                        if (options.abortEarly) {
                            return finish();
                        }
                    }

                    if (result.value !== undefined) {
                        target[key] = result.value;
                    }
                }
            }
        }

        unprocessedKeys = Object.keys(unprocessed);
    }

    if ((this._inner.children || this._inner.patterns.length) && unprocessedKeys.length) {
        if (options.stripUnknown ||
            options.skipFunctions) {

            for (let i = 0; i < unprocessedKeys.length; ++i) {
                const key = unprocessedKeys[i];

                if (options.stripUnknown) {
                    delete target[key];
                    delete unprocessed[key];
                }
                else if (typeof target[key] === 'function') {
                    delete unprocessed[key];
                }
            }

            unprocessedKeys = Object.keys(unprocessed);
        }

        if (unprocessedKeys.length &&
            (this._flags.allowUnknown !== undefined ? !this._flags.allowUnknown : !options.allowUnknown)) {

            for (let i = 0; i < unprocessedKeys.length; ++i) {
                errors.push(this.createError('object.allowUnknown', null, { key: unprocessedKeys[i], path: state.path + (state.path ? '.' : '') + unprocessedKeys[i] }, childOptions));
            }
        }
    }

    // Validate dependencies

    for (let i = 0; i < this._inner.dependencies.length; ++i) {
        const dep = this._inner.dependencies[i];
        const err = internals[dep.type].call(this, dep.key !== null && value[dep.key], dep.peers, target, { key: dep.key, path: (state.path || '') + (dep.key ? '.' + dep.key : '') }, options);
        if (err) {
            errors.push(err);
            if (options.abortEarly) {
                return finish();
            }
        }
    }

    return finish();
};


internals.Object.prototype._func = function () {

    const obj = this.clone();
    obj._flags.func = true;
    return obj;
};


internals.Object.prototype.keys = function (schema) {

    Hoek.assert(schema === null || schema === undefined || typeof schema === 'object', 'Object schema must be a valid object');
    Hoek.assert(!schema || !schema.isJoi, 'Object schema cannot be a joi schema');

    const obj = this.clone();

    if (!schema) {
        obj._inner.children = null;
        return obj;
    }

    const children = Object.keys(schema);

    if (!children.length) {
        obj._inner.children = [];
        return obj;
    }

    const topo = new Topo();
    if (obj._inner.children) {
        for (let i = 0; i < obj._inner.children.length; ++i) {
            const child = obj._inner.children[i];

            // Only add the key if we are not going to replace it later
            if (children.indexOf(child.key) === -1) {
                topo.add(child, { after: child._refs, group: child.key });
            }
        }
    }

    for (let i = 0; i < children.length; ++i) {
        const key = children[i];
        const child = schema[key];
        try {
            const cast = Cast.schema(child);
            topo.add({ key, schema: cast }, { after: cast._refs, group: key });
        }
        catch (castErr) {
            if (castErr.hasOwnProperty('path')) {
                castErr.path = key + '.' + castErr.path;
            }
            else {
                castErr.path = key;
            }
            throw castErr;
        }
    }

    obj._inner.children = topo.nodes;

    return obj;
};


internals.Object.prototype.unknown = function (allow) {

    const obj = this.clone();
    obj._flags.allowUnknown = (allow !== false);
    return obj;
};


internals.Object.prototype.length = function (limit) {

    Hoek.assert(Hoek.isInteger(limit) && limit >= 0, 'limit must be a positive integer');

    return this._test('length', limit, (value, state, options) => {

        if (Object.keys(value).length === limit) {
            return null;
        }

        return this.createError('object.length', { limit }, state, options);
    });
};

internals.Object.prototype.arity = function (n) {

    Hoek.assert(Hoek.isInteger(n) && n >= 0, 'n must be a positive integer');

    return this._test('arity', n, (value, state, options) => {

        if (value.length === n) {
            return null;
        }

        return this.createError('function.arity', { n }, state, options);
    });
};

internals.Object.prototype.minArity = function (n) {

    Hoek.assert(Hoek.isInteger(n) && n > 0, 'n must be a strict positive integer');

    return this._test('minArity', n, (value, state, options) => {

        if (value.length >= n) {
            return null;
        }

        return this.createError('function.minArity', { n }, state, options);
    });
};

internals.Object.prototype.maxArity = function (n) {

    Hoek.assert(Hoek.isInteger(n) && n >= 0, 'n must be a positive integer');

    return this._test('maxArity', n, (value, state, options) => {

        if (value.length <= n) {
            return null;
        }

        return this.createError('function.maxArity', { n }, state, options);
    });
};


internals.Object.prototype.min = function (limit) {

    Hoek.assert(Hoek.isInteger(limit) && limit >= 0, 'limit must be a positive integer');

    return this._test('min', limit, (value, state, options) => {

        if (Object.keys(value).length >= limit) {
            return null;
        }

        return this.createError('object.min', { limit }, state, options);
    });
};


internals.Object.prototype.max = function (limit) {

    Hoek.assert(Hoek.isInteger(limit) && limit >= 0, 'limit must be a positive integer');

    return this._test('max', limit, (value, state, options) => {

        if (Object.keys(value).length <= limit) {
            return null;
        }

        return this.createError('object.max', { limit }, state, options);
    });
};


internals.Object.prototype.pattern = function (pattern, schema) {

    Hoek.assert(pattern instanceof RegExp, 'Invalid regular expression');
    Hoek.assert(schema !== undefined, 'Invalid rule');

    pattern = new RegExp(pattern.source, pattern.ignoreCase ? 'i' : undefined);         // Future version should break this and forbid unsupported regex flags

    try {
        schema = Cast.schema(schema);
    }
    catch (castErr) {
        if (castErr.hasOwnProperty('path')) {
            castErr.message = castErr.message + '(' + castErr.path + ')';
        }

        throw castErr;
    }


    const obj = this.clone();
    obj._inner.patterns.push({ regex: pattern, rule: schema });
    return obj;
};


internals.Object.prototype.with = function (key, peers) {

    return this._dependency('with', key, peers);
};


internals.Object.prototype.without = function (key, peers) {

    return this._dependency('without', key, peers);
};


internals.Object.prototype.xor = function () {

    const peers = Hoek.flatten(Array.prototype.slice.call(arguments));
    return this._dependency('xor', null, peers);
};


internals.Object.prototype.or = function () {

    const peers = Hoek.flatten(Array.prototype.slice.call(arguments));
    return this._dependency('or', null, peers);
};


internals.Object.prototype.and = function () {

    const peers = Hoek.flatten(Array.prototype.slice.call(arguments));
    return this._dependency('and', null, peers);
};


internals.Object.prototype.nand = function () {

    const peers = Hoek.flatten(Array.prototype.slice.call(arguments));
    return this._dependency('nand', null, peers);
};


internals.Object.prototype.requiredKeys = function (children) {

    children = Hoek.flatten(Array.prototype.slice.call(arguments));
    return this.applyFunctionToChildren(children, 'required');
};


internals.Object.prototype.optionalKeys = function (children) {

    children = Hoek.flatten(Array.prototype.slice.call(arguments));
    return this.applyFunctionToChildren(children, 'optional');
};


internals.renameDefaults = {
    alias: false,                   // Keep old value in place
    multiple: false,                // Allow renaming multiple keys into the same target
    override: false                 // Overrides an existing key
};


internals.Object.prototype.rename = function (from, to, options) {

    Hoek.assert(typeof from === 'string', 'Rename missing the from argument');
    Hoek.assert(typeof to === 'string', 'Rename missing the to argument');
    Hoek.assert(to !== from, 'Cannot rename key to same name:', from);

    for (let i = 0; i < this._inner.renames.length; ++i) {
        Hoek.assert(this._inner.renames[i].from !== from, 'Cannot rename the same key multiple times');
    }

    const obj = this.clone();

    obj._inner.renames.push({
        from,
        to,
        options: Hoek.applyToDefaults(internals.renameDefaults, options || {})
    });

    return obj;
};


internals.groupChildren = function (children) {

    children.sort();

    const grouped = {};

    for (let i = 0; i < children.length; ++i) {
        const child = children[i];
        Hoek.assert(typeof child === 'string', 'children must be strings');
        const group = child.split('.')[0];
        const childGroup = grouped[group] = (grouped[group] || []);
        childGroup.push(child.substring(group.length + 1));
    }

    return grouped;
};


internals.Object.prototype.applyFunctionToChildren = function (children, fn, args, root) {

    children = [].concat(children);
    Hoek.assert(children.length > 0, 'expected at least one children');

    const groupedChildren = internals.groupChildren(children);
    let obj;

    if ('' in groupedChildren) {
        obj = this[fn].apply(this, args);
        delete groupedChildren[''];
    }
    else {
        obj = this.clone();
    }

    if (obj._inner.children) {
        root = root ? (root + '.') : '';

        for (let i = 0; i < obj._inner.children.length; ++i) {
            const child = obj._inner.children[i];
            const group = groupedChildren[child.key];

            if (group) {
                obj._inner.children[i] = {
                    key: child.key,
                    _refs: child._refs,
                    schema: child.schema.applyFunctionToChildren(group, fn, args, root + child.key)
                };

                delete groupedChildren[child.key];
            }
        }
    }

    const remaining = Object.keys(groupedChildren);
    Hoek.assert(remaining.length === 0, 'unknown key(s)', remaining.join(', '));

    return obj;
};


internals.Object.prototype._dependency = function (type, key, peers) {

    peers = [].concat(peers);
    for (let i = 0; i < peers.length; ++i) {
        Hoek.assert(typeof peers[i] === 'string', type, 'peers must be a string or array of strings');
    }

    const obj = this.clone();
    obj._inner.dependencies.push({ type, key, peers });
    return obj;
};


internals.with = function (value, peers, parent, state, options) {

    if (value === undefined) {
        return null;
    }

    for (let i = 0; i < peers.length; ++i) {
        const peer = peers[i];
        if (!Object.prototype.hasOwnProperty.call(parent, peer) ||
            parent[peer] === undefined) {

            return this.createError('object.with', { peer }, state, options);
        }
    }

    return null;
};


internals.without = function (value, peers, parent, state, options) {

    if (value === undefined) {
        return null;
    }

    for (let i = 0; i < peers.length; ++i) {
        const peer = peers[i];
        if (Object.prototype.hasOwnProperty.call(parent, peer) &&
            parent[peer] !== undefined) {

            return this.createError('object.without', { peer }, state, options);
        }
    }

    return null;
};


internals.xor = function (value, peers, parent, state, options) {

    const present = [];
    for (let i = 0; i < peers.length; ++i) {
        const peer = peers[i];
        if (Object.prototype.hasOwnProperty.call(parent, peer) &&
            parent[peer] !== undefined) {

            present.push(peer);
        }
    }

    if (present.length === 1) {
        return null;
    }

    if (present.length === 0) {
        return this.createError('object.missing', { peers }, state, options);
    }

    return this.createError('object.xor', { peers }, state, options);
};


internals.or = function (value, peers, parent, state, options) {

    for (let i = 0; i < peers.length; ++i) {
        const peer = peers[i];
        if (Object.prototype.hasOwnProperty.call(parent, peer) &&
            parent[peer] !== undefined) {
            return null;
        }
    }

    return this.createError('object.missing', { peers }, state, options);
};


internals.and = function (value, peers, parent, state, options) {

    const missing = [];
    const present = [];
    const count = peers.length;
    for (let i = 0; i < count; ++i) {
        const peer = peers[i];
        if (!Object.prototype.hasOwnProperty.call(parent, peer) ||
            parent[peer] === undefined) {

            missing.push(peer);
        }
        else {
            present.push(peer);
        }
    }

    const aon = (missing.length === count || present.length === count);
    return !aon ? this.createError('object.and', { present, missing }, state, options) : null;
};


internals.nand = function (value, peers, parent, state, options) {

    const present = [];
    for (let i = 0; i < peers.length; ++i) {
        const peer = peers[i];
        if (Object.prototype.hasOwnProperty.call(parent, peer) &&
            parent[peer] !== undefined) {

            present.push(peer);
        }
    }

    const values = Hoek.clone(peers);
    const main = values.splice(0, 1)[0];
    const allPresent = (present.length === peers.length);
    return allPresent ? this.createError('object.nand', { main, peers: values }, state, options) : null;
};


internals.Object.prototype.describe = function (shallow) {

    const description = Any.prototype.describe.call(this);

    if (description.rules) {
        for (let i = 0; i < description.rules.length; ++i) {
            const rule = description.rules[i];
            // Coverage off for future-proof descriptions, only object().assert() is use right now
            if (/* $lab:coverage:off$ */rule.arg &&
                typeof rule.arg === 'object' &&
                rule.arg.schema &&
                rule.arg.ref /* $lab:coverage:on$ */) {
                rule.arg = {
                    schema: rule.arg.schema.describe(),
                    ref: rule.arg.ref.toString()
                };
            }
        }
    }

    if (this._inner.children &&
        !shallow) {

        description.children = {};
        for (let i = 0; i < this._inner.children.length; ++i) {
            const child = this._inner.children[i];
            description.children[child.key] = child.schema.describe();
        }
    }

    if (this._inner.dependencies.length) {
        description.dependencies = Hoek.clone(this._inner.dependencies);
    }

    if (this._inner.patterns.length) {
        description.patterns = [];

        for (let i = 0; i < this._inner.patterns.length; ++i) {
            const pattern = this._inner.patterns[i];
            description.patterns.push({ regex: pattern.regex.toString(), rule: pattern.rule.describe() });
        }
    }

    return description;
};


internals.Object.prototype.assert = function (ref, schema, message) {

    ref = Cast.ref(ref);
    Hoek.assert(ref.isContext || ref.depth > 1, 'Cannot use assertions for root level references - use direct key rules instead');
    message = message || 'pass the assertion test';

    try {
        schema = Cast.schema(schema);
    }
    catch (castErr) {
        if (castErr.hasOwnProperty('path')) {
            castErr.message = castErr.message + '(' + castErr.path + ')';
        }

        throw castErr;
    }

    const key = ref.path[ref.path.length - 1];
    const path = ref.path.join('.');

    return this._test('assert', { schema, ref }, (value, state, options) => {

        const result = schema._validate(ref(value), null, options, value);
        if (!result.errors) {
            return null;
        }

        const localState = Hoek.merge({}, state);
        localState.key = key;
        localState.path = path;
        return this.createError('object.assert', { ref: localState.path, message }, localState, options);
    });
};


internals.Object.prototype.type = function (constructor, name) {

    Hoek.assert(typeof constructor === 'function', 'type must be a constructor function');
    name = name || constructor.name;

    return this._test('type', name, (value, state, options) => {

        if (value instanceof constructor) {
            return null;
        }

        return this.createError('object.type', { type: name }, state, options);
    });
};


module.exports = new internals.Object();
