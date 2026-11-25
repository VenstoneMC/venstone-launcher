import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMicrosoft, sameAccount, skinPage, microsoftError } from '../src/assets/js/utils/accounts.js';

const venstone = name => ({ name, meta: { type: 'Mojang', online: false } });
const microsoft = name => ({ name, meta: { type: 'Xbox' } });

test('même pseudo autorisé seulement entre types différents', () => {
    assert.equal(sameAccount(venstone('Steve'), venstone('steve')), true);
    assert.equal(sameAccount(microsoft('Steve'), microsoft('Steve')), true);
    assert.equal(sameAccount(venstone('Steve'), microsoft('Steve')), false);
    assert.equal(sameAccount(venstone('Steve'), venstone('Alex')), false);
});

test('page de skin selon le type de compte', () => {
    assert.equal(isMicrosoft(microsoft('a')), true);
    assert.match(skinPage(microsoft('a')), /minecraft\.net\/fr-fr\/msaprofile\/mygames\/editskin/);
    assert.match(skinPage(venstone('a')), /venstone\.xyz\/skin/);
});

test('messages des erreurs Microsoft', () => {
    assert.equal(microsoftError({ error: 'cancel' }), null);
    assert.match(microsoftError({ error: 'noGame' }), /ne possède pas Minecraft/);
    assert.match(microsoftError({ error: 'inconnu', message: 'détail' }), /détail/);
});
