'use strict';

const form = document.querySelector('#form');
const container = document.querySelector('#questions');
const message = document.querySelector('#message');
const actions = document.querySelector('#actions');
const submit = document.querySelector('#submit');
const cancel = document.querySelector('#cancel');
const back = document.querySelector('#back');
const ready = document.querySelector('#ready');
const hint = document.querySelector('#hint');
const cards = [];
let current = 0;
let sending = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function updateProgress() {
  const entry = cards[current];
  document.querySelector('#progress').textContent = entry
    ? 'Question ' + (current + 1) + ' / ' + cards.length
    : cards.length + ' / ' + cards.length + ' reviewed';
  submit.textContent = entry ? 'Next →' : 'Send answers →';
  // On returning to a single-choice answer, Next keeps the current choice.
  submit.disabled = sending || Boolean(entry && entry.question.type === 'single' &&
    entry.question.required && !entry.inputs.some((input) => input.checked));
}

function updateNoteToggle(entry) {
  const hasNote = entry.note.value.trim().length > 0;
  entry.noteToggle.textContent = (entry.noteLabel.hidden
    ? (hasNote ? 'Edit note' : 'Add note') : 'Hide note') + ' · N';
  entry.noteToggle.setAttribute('aria-expanded', String(!entry.noteLabel.hidden));
  entry.notePreview.textContent = entry.note.value;
  entry.notePreview.hidden = !entry.noteLabel.hidden || !hasNote;
}

function toggleNote(entry) {
  entry.noteLabel.hidden = !entry.noteLabel.hidden;
  updateNoteToggle(entry);
  (entry.noteLabel.hidden ? entry.noteToggle : entry.note).focus();
}

function showStep(index, focus = true) {
  current = index;
  cards.forEach(({ card }, position) => { card.hidden = position !== current; });
  ready.hidden = current < cards.length;
  back.disabled = sending || current === 0;
  message.textContent = '';
  const entry = cards[current];
  hint.textContent = !entry ? 'Enter to send · Back to change an answer'
    : entry.question.type === 'single'
      ? 'Number to choose & advance · N for notes · Enter to continue'
      : 'Numbers to toggle choices · N for notes · Enter for Next';
  if (entry) updateNoteToggle(entry);
  updateProgress();
  if (focus) (entry ? entry.legend : document.querySelector('#ready-title')).focus();
}

function validateCard(entry) {
  if (entry.question.required && !entry.inputs.some((input) => input.checked)) {
    entry.card.classList.add('invalid');
    entry.cardError.textContent = 'Please choose an option.';
    entry.inputs[0].focus();
    return false;
  }
  return true;
}

function renderQuestion(question, index) {
  const card = element('fieldset', 'question');
  card.hidden = true;
  const legend = element('legend', '', question.prompt);
  legend.tabIndex = -1;
  card.append(legend);
  card.append(element('p', 'question-meta',
    'QUESTION ' + (index + 1) + ' · ' +
    (question.type === 'multiple' ? 'Choose one or more' : 'Choose one') +
    (question.required ? '' : ' · Optional')));

  // Notes are collapsed by default, but preserved when hidden or navigating.
  const noteToggle = element('button', 'note-toggle', 'Add note · N');
  noteToggle.type = 'button';
  noteToggle.setAttribute('aria-keyshortcuts', 'n');
  noteToggle.setAttribute('aria-controls', 'note-' + index);
  card.append(noteToggle);
  const noteLabel = element('label', 'note-label', 'Additional note');
  noteLabel.append(element('span', '', ' · optional'));
  const note = element('textarea');
  note.id = 'note-' + index;
  noteLabel.hidden = true;
  note.rows = 2;
  note.maxLength = 20000;
  note.placeholder = question.type === 'single'
    ? 'Add a note before choosing, if you have one…'
    : 'Anything else the agent should know?';
  note.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter Escape');
  noteLabel.append(note, element('span', 'note-help', '⌘ Enter / Ctrl Enter to continue · Esc to close'));
  const notePreview = element('p', 'note-preview');
  notePreview.hidden = true;
  card.append(noteLabel, notePreview);

  const cardError = element('p', 'card-error');
  cardError.setAttribute('role', 'alert');
  const inputs = question.options.map((option, optionIndex) => {
    const label = element('label', 'option');
    const input = element('input');
    input.type = question.type === 'multiple' ? 'checkbox' : 'radio';
    // Generated names, rather than agent-provided IDs, keep radio groups isolated.
    input.name = 'question-' + index;
    input.value = option.id;
    const shortcut = optionIndex < 10 ? String((optionIndex + 1) % 10) : '';
    if (shortcut) {
      input.setAttribute('aria-keyshortcuts', shortcut);
      const badge = element('kbd', 'option-key', shortcut);
      badge.setAttribute('aria-hidden', 'true');
      label.append(badge);
    }
    const text = element('span', 'option-text');
    text.append(element('strong', '', option.label));
    if (option.description) text.append(element('span', 'description', option.description));
    label.append(input, text);
    card.append(label);
    input.addEventListener('change', () => {
      card.classList.remove('invalid');
      cardError.textContent = '';
      if (question.type === 'single' && input.checked) showStep(index + 1);
      else updateProgress();
    });
    return input;
  });
  if (!question.required) {
    const clear = element('button', 'clear', 'Clear selection');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      inputs.forEach((input) => { input.checked = false; });
      updateProgress();
    });
    card.append(clear);
  }
  card.append(cardError);
  container.append(card);
  const entry = { question, card, legend, inputs, note, noteLabel, noteToggle, notePreview, cardError };
  cards.push(entry);
  noteToggle.addEventListener('click', () => toggleNote(entry));
  note.addEventListener('input', () => updateNoteToggle(entry));
  updateNoteToggle(entry);
}

async function send(payload) {
  if (sending) return;
  sending = true;
  submit.disabled = cancel.disabled = back.disabled = true;
  cards.forEach(({ card }) => { card.disabled = true; });
  message.textContent = 'Sending…';
  try {
    const response = await fetch('answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not submit answers.');
    // Preserve the confirmation page after the CLI shuts its server down.
    container.hidden = ready.hidden = actions.hidden = true;
    message.className = 'success';
    message.textContent = payload.status === 'answered'
      ? 'Answers delivered to the agent. You can close this tab.'
      : 'Cancelled. The agent has been notified. You can close this tab.';
    // Most browsers block this for externally opened tabs. Keep the confirmation
    // intact, and never turn a blocked close into a retry of delivered answers.
    try {
      window.close();
    } catch {
      // Best effort only; manual closing is the fallback.
    }
  } catch (error) {
    message.textContent = error.message + ' If the agent stopped waiting, start a new session.';
    sending = false;
    cards.forEach(({ card }) => { card.disabled = false; });
    cancel.disabled = false;
    back.disabled = current === 0;
    updateProgress();
  }
}

function advance() {
  if (sending || !cards.length) return;
  if (current < cards.length) {
    if (validateCard(cards[current])) showStep(current + 1);
    return;
  }
  const invalidIndex = cards.findIndex(({ question, inputs }) =>
    question.required && !inputs.some((input) => input.checked));
  if (invalidIndex !== -1) {
    showStep(invalidIndex);
    validateCard(cards[invalidIndex]);
    return;
  }
  const answers = cards.map(({ question, inputs, note }) => ({
    questionId: question.id,
    selected: inputs.filter((input) => input.checked).map((input) => input.value),
    note: note.value,
  }));
  send({ status: 'answered', answers });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  advance();
});

document.addEventListener('keydown', (event) => {
  if (sending || !cards.length || event.defaultPrevented || event.repeat || event.isComposing) return;
  const entry = cards[current];
  const target = event.target;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey &&
    entry && target === entry.note) {
    event.preventDefault();
    advance();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape' && entry && target === entry.note && !entry.noteLabel.hidden) {
    event.preventDefault();
    toggleNote(entry);
    return;
  }
  // Never interpret typed text (or IME composition) as an answer shortcut.
  if (target?.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target?.tagName) ||
    (target?.tagName === 'INPUT' && !['radio', 'checkbox'].includes(target.type))) return;
  if (event.key.toLowerCase() === 'n' && entry) {
    event.preventDefault();
    toggleNote(entry);
  } else if (/^[0-9]$/.test(event.key) && entry) {
    const index = event.key === '0' ? 9 : Number(event.key) - 1;
    const input = entry.inputs[index];
    if (!input) return;
    event.preventDefault();
    // Native click keeps radio-group and checkbox behavior identical to mouse use.
    input.click();
  } else if (event.key === 'Enter' && target?.tagName !== 'BUTTON') {
    event.preventDefault();
    advance();
  }
});

back.addEventListener('click', () => {
  if (!sending && current > 0) showStep(current - 1);
});

cancel.addEventListener('click', () => {
  if (window.confirm('Cancel this batch without sending your answers?')) send({ status: 'cancelled' });
});

async function load() {
  try {
    const response = await fetch('questions');
    if (!response.ok) throw new Error('Could not load questions.');
    const batch = await response.json();
    document.querySelector('#title').textContent = batch.title;
    document.title = 'dask · ' + batch.title;
    batch.questions.forEach(renderQuestion);
    actions.hidden = false;
    showStep(0, false);
  } catch (error) {
    document.querySelector('#title').textContent = 'Unable to load this session';
    message.textContent = error.message + ' Check that dask is still running.';
  }
}

load();
