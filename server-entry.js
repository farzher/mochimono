await Promise.all([
  import('./server.js'),
  import('./friend-signaling-server.js')
]);
