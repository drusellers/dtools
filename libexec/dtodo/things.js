// JXA, executed only by osascript. Read-only public Things scripting properties.
// Dictionary: /Applications/Things3.app/Contents/Resources/Things.sdef
function run(argv) {
  var app = Application('com.culturedcode.ThingsMac');
  // Refuse to launch a closed app implicitly.
  if (!app.running()) throw new Error('Open Things before running dtodo.');
  var today = argv[0] === 'today';
  var trash = app.lists.byId('TMTrash').toDos.id();
  var projects = app.projects.id();
  var items = today ? app.lists.byId('TMToday').toDos() : app.toDos.whose({ status: 'open' })();
  function day(value) {
    if (!value) return null;
    function pad(n) { return ('0' + n).slice(-2); }
    return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
  }
  function parentName(value) {
    return value ? value.name() : null;
  }
  var result = [];
  items.forEach(function (task) {
    var id = task.id();
    if (task.status() !== 'open' || trash.indexOf(id) !== -1) return;
    // Projects inherit to-do properties, but aren't individual tasks.
    if (projects.indexOf(id) !== -1) return;
    result.push({
      source: 'things', id: id, title: task.name(), status: 'open', sourceStatus: 'open',
      dueDate: day(task.dueDate()), project: parentName(task.project()),
      area: parentName(task.area()), projectIds: [],
      url: 'things:///show?id=' + encodeURIComponent(id)
    });
  });
  return JSON.stringify(result);
}
