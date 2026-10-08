import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

const script = await readFile(new URL('app.js', import.meta.url), 'utf8');
const batch = {
  title: 'Plan',
  questions: [
    { id: 'one', prompt: 'First?', type: 'single', required: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { id: 'many', prompt: 'Several?', type: 'multiple', required: true, options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
    { id: 'optional', prompt: 'Extras?', type: 'single', required: false, options: [{ id: 'z', label: 'Z' }] },
  ],
};

// A minimal DOM harness tests UI behavior without opening a browser or adding
// dependencies. It doesn't test browser layout or native radio/keyboard behavior.
async function ui({ failSend = false, batchInput = batch, closeThrows = false } = {}) {
  let focused;
  let closeAttempts = 0;
  const elements = [];
  const documentEvents = new Map();
  class Element {
    children = [];
    events = new Map();
    hidden = false;
    disabled = false;
    checked = false;
    value = '';
    textContent = '';
    classList = { add() {}, remove() {} };
    attributes = new Map();
    constructor(tag) { this.tagName = tag.toUpperCase(); elements.push(this); }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    click() {
      if (this.disabled) return;
      if (this.tagName === 'INPUT') {
        if (this.type === 'radio') {
          if (this.checked) return;
          elements.filter((node) => node.type === 'radio' && node.name === this.name)
            .forEach((node) => { node.checked = false; });
          this.checked = true;
        } else this.checked = !this.checked;
        this.emit('change');
      } else this.emit('click');
    }
    addEventListener(name, listener) { this.events.set(name, listener); }
    emit(name) { this.events.get(name)?.({ preventDefault() {} }); }
    focus() { focused = this; }
  }
  const ids = new Map(['form', 'questions', 'message', 'actions', 'submit', 'cancel', 'back', 'ready', 'hint', 'progress', 'ready-title', 'title']
    .map((id) => ['#' + id, new Element(['submit', 'cancel', 'back'].includes(id) ? 'button' : 'div')]));
  const posts = [];
  const context = createContext({
    document: {
      querySelector: (id) => ids.get(id), createElement: (tag) => new Element(tag),
      addEventListener: (name, listener) => documentEvents.set(name, listener),
    },
    window: {
      confirm: () => true,
      close: () => {
        closeAttempts++;
        if (closeThrows) throw new Error('Browser blocked window.close');
      },
    },
    fetch: async (route, options) => {
      if (route === 'questions') return { ok: true, json: async () => batchInput };
      posts.push(JSON.parse(options.body));
      return { ok: !failSend, json: async () => failSend ? { error: 'Try again.' } : { ok: true } };
    },
  });
  runInContext(script, context);
  await setImmediate();
  const cards = runInContext('cards', context);
  return {
    cards, posts,
    key: (key, overrides = {}) => {
      const event = { key, target: focused ?? cards[0].legend, ...overrides,
        preventDefault() { this.defaultPrevented = true; } };
      documentEvents.get('keydown')(event);
      return event;
    },
    node: (id) => ids.get('#' + id),
    choose: (index, option) => {
      const entry = cards[index];
      if (entry.question.type === 'single') entry.inputs.forEach((input) => { input.checked = false; });
      entry.inputs[option].checked = true;
      entry.inputs[option].emit('change');
    },
    next: () => ids.get('#form').emit('submit'),
    back: () => ids.get('#back').emit('click'),
    get focused() { return focused; },
    get closeAttempts() { return closeAttempts; },
  };
}

test('single-choice clears the current card; notes survive Back and edits', async () => {
  const app = await ui();
  assert.equal(app.cards[0].card.hidden, false);
  assert.equal(app.cards[1].card.hidden, true);
  assert.equal(app.node('submit').disabled, true);
  // Notes are physically above the option labels.
  assert.equal(app.cards[0].card.children[3], app.cards[0].noteLabel);
  app.cards[0].note.value = 'Before choosing';
  app.choose(0, 0);
  assert.equal(app.cards[0].card.hidden, true);
  assert.equal(app.cards[1].card.hidden, false);
  assert.equal(app.focused, app.cards[1].legend);
  assert.equal(app.posts.length, 0);
  app.back();
  assert.equal(app.cards[0].note.value, 'Before choosing');
  assert.equal(app.cards[0].notePreview.hidden, false);
  assert.equal(app.cards[0].notePreview.textContent, 'Before choosing');
  assert.equal(app.cards[0].inputs[0].checked, true);
  assert.equal(app.node('submit').disabled, false);
  app.cards[0].note.value += ' and after returning';
  app.choose(0, 1);
  assert.equal(app.cards[1].card.hidden, false);
  assert.equal(app.cards[0].inputs[1].checked, true);
});

test('multiple choice stays until Next; optional skip and final send preserve all answers', async () => {
  const app = await ui();
  app.choose(0, 0);
  app.next();
  assert.equal(app.cards[1].cardError.textContent, 'Please choose an option.');
  assert.equal(app.cards[1].card.hidden, false);
  app.choose(1, 0);
  app.choose(1, 1);
  app.cards[1].note.value = 'Both please';
  assert.equal(app.cards[1].card.hidden, false);
  app.next();
  assert.equal(app.cards[1].card.hidden, true);
  assert.equal(app.cards[2].card.hidden, false);
  app.cards[2].note.value = 'No extras';
  app.next();
  assert.ok(app.cards.every(({ card }) => card.hidden));
  assert.equal(app.node('ready').hidden, false);
  assert.equal(app.node('submit').textContent, 'Send answers →');
  assert.equal(app.posts.length, 0);
  app.back();
  assert.equal(app.cards[2].note.value, 'No extras');
  app.next();
  app.next();
  await setImmediate();
  assert.deepEqual(app.posts, [{ status: 'answered', answers: [
    { questionId: 'one', selected: ['a'], note: '' },
    { questionId: 'many', selected: ['x', 'y'], note: 'Both please' },
    { questionId: 'optional', selected: [], note: 'No extras' },
  ] }]);
  assert.equal(app.node('actions').hidden, true);
  assert.equal(app.node('ready').hidden, true);
  assert.match(app.node('message').textContent, /delivered/);
  assert.equal(app.closeAttempts, 1);
});

test('cancel works mid-batch and does not send partial answers', async () => {
  const app = await ui();
  app.choose(0, 0);
  app.node('cancel').emit('click');
  await setImmediate();
  assert.deepEqual(app.posts, [{ status: 'cancelled' }]);
  assert.equal(app.node('questions').hidden, true);
  assert.equal(app.closeAttempts, 1);
});

test('failed submission keeps choices and notes editable', async () => {
  const app = await ui({ failSend: true });
  app.choose(0, 0);
  app.choose(1, 0);
  app.next();
  app.next();
  app.next();
  await setImmediate();
  assert.match(app.node('message').textContent, /Try again/);
  assert.equal(app.closeAttempts, 0);
  assert.equal(app.node('submit').disabled, false);
  assert.equal(app.node('back').disabled, false);
  app.back();
  app.back();
  assert.equal(app.cards[1].inputs[0].checked, true);
  assert.equal(app.cards[1].card.disabled, false);
});

test('blocked auto-close leaves the successful confirmation intact and prevents resubmission', async () => {
  const app = await ui({ closeThrows: true });
  app.key('1');
  app.key('1');
  app.key('Enter');
  app.key('Enter');
  app.key('Enter');
  await setImmediate();
  assert.equal(app.closeAttempts, 1);
  assert.match(app.node('message').textContent, /Answers delivered.*close this tab/);
  assert.equal(app.node('actions').hidden, true);
  app.key('Enter');
  app.next();
  assert.equal(app.posts.length, 1);
});

test('number shortcuts select single choice and toggle multiple choices; Enter advances and sends', async () => {
  const app = await ui();
  assert.equal(app.key('2').defaultPrevented, true);
  assert.equal(app.cards[0].inputs[1].checked, true);
  assert.equal(app.cards[1].card.hidden, false);
  app.key('1');
  app.key('2');
  app.key('1');
  assert.equal(app.cards[1].inputs[0].checked, false);
  assert.equal(app.cards[1].inputs[1].checked, true);
  assert.equal(app.cards[1].card.hidden, false);
  app.key('Enter');
  assert.equal(app.cards[2].card.hidden, false);
  app.key('Enter');
  assert.equal(app.node('ready').hidden, false);
  assert.equal(app.posts.length, 0);
  app.key('Enter');
  await setImmediate();
  assert.equal(app.posts.length, 1);
  assert.deepEqual(app.posts[0].answers[1].selected, ['y']);
});

test('N toggles notes, typing is untouched, and Escape hides without losing text', async () => {
  const app = await ui();
  const entry = app.cards[0];
  assert.equal(entry.noteLabel.hidden, true);
  app.key('n');
  assert.equal(entry.noteLabel.hidden, false);
  assert.equal(app.focused, entry.note);
  assert.equal(entry.noteToggle.attributes.get('aria-expanded'), 'true');
  for (const key of ['n', '1', 'Enter']) assert.equal(app.key(key).defaultPrevented, undefined);
  assert.equal(entry.inputs[0].checked, false);
  entry.note.value = 'n and 1 are just text';
  app.key('Escape');
  assert.equal(entry.noteLabel.hidden, true);
  assert.equal(app.focused, entry.noteToggle);
  assert.equal(entry.note.value, 'n and 1 are just text');
  assert.equal(entry.noteToggle.textContent, 'Edit note · N');
  assert.equal(entry.notePreview.hidden, false);
  assert.equal(entry.notePreview.textContent, entry.note.value);
  app.key('N');
  assert.equal(entry.noteLabel.hidden, false);
  assert.equal(entry.notePreview.hidden, true);
  entry.noteToggle.click();
  assert.equal(entry.noteLabel.hidden, true);
});

test('Command/Ctrl Enter in a textarea advances while preserving the note and required validation', async () => {
  const app = await ui();
  app.key('n');
  app.cards[0].note.value = 'Needs a choice';
  assert.equal(app.key('Enter', { metaKey: true }).defaultPrevented, true);
  assert.equal(app.cards[0].card.hidden, false);
  assert.equal(app.cards[0].cardError.textContent, 'Please choose an option.');
  app.key('1');
  app.key('2');
  app.key('n');
  app.cards[1].note.value = 'Keep this note';
  app.key('Enter', { metaKey: true });
  assert.equal(app.cards[2].card.hidden, false);
  assert.equal(app.cards[1].note.value, 'Keep this note');
  app.key('n');
  app.cards[2].note.value = 'Only a note';
  app.key('Enter', { ctrlKey: true });
  assert.equal(app.node('ready').hidden, false);
  app.key('Enter');
  await setImmediate();
  assert.equal(app.posts[0].answers[2].note, 'Only a note');
  assert.deepEqual(app.posts[0].answers[2].selected, []);
});

test('repeated, composing, modified, editing and out-of-range keys do not answer', async () => {
  const app = await ui();
  for (const overrides of [
    { repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true },
    { altKey: true }, { defaultPrevented: true },
    { target: { isContentEditable: true } },
    { target: { tagName: 'INPUT', type: 'text' } },
  ]) app.key('1', overrides);
  app.key('9');
  assert.equal(app.cards[0].inputs[0].checked, false);
  app.key('1');
  app.key('1', { repeat: true });
  assert.equal(app.cards[1].inputs[0].checked, false);
  assert.equal(app.key('Enter', { target: app.node('back') }).defaultPrevented, undefined);
});

test('the tenth option is labeled and selected with 0', async () => {
  const app = await ui({ batchInput: { title: 'Ten', questions: [{
    id: 'ten', prompt: 'Choose', type: 'single', required: true,
    options: Array.from({ length: 10 }, (_, index) => ({ id: String(index), label: 'Option ' + index })),
  }] } });
  assert.equal(app.cards[0].inputs[9].attributes.get('aria-keyshortcuts'), '0');
  app.key('0');
  assert.equal(app.cards[0].inputs[9].checked, true);
  assert.equal(app.node('ready').hidden, false);
});

test('collapsed preview preserves multiline plain text and disappears when the note is cleared', async () => {
  const app = await ui();
  const entry = app.cards[0];
  assert.equal(entry.notePreview.hidden, true);
  app.key('n');
  entry.note.value = 'First line\n<script>just text</script>';
  entry.note.emit('input');
  assert.equal(entry.notePreview.hidden, true);
  app.key('Escape');
  assert.equal(entry.notePreview.hidden, false);
  assert.equal(entry.notePreview.textContent, entry.note.value);
  app.key('n');
  entry.note.value = '';
  entry.note.emit('input');
  app.key('Escape');
  assert.equal(entry.notePreview.hidden, true);
  assert.equal(entry.noteToggle.textContent, 'Add note · N');
  app.key('1');
  assert.equal(app.cards[1].card.hidden, false);
});
