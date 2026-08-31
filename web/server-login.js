if (!document.documentElement.classList.contains('client-library')) {
  addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('#login-form');
    const token = document.querySelector('#token');
    const logout = document.querySelector('#logout');
    if (form && token) {
      token.type = 'text';
      token.id = 'username';
      token.placeholder = 'Username';
      token.value = 'admin';
      token.autocomplete = 'username';
      const password = document.createElement('input');
      password.id = 'password';
      password.type = 'password';
      password.placeholder = 'Password';
      password.autocomplete = 'current-password';
      token.after(password);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const error = document.querySelector('#login-error');
        if (error) error.textContent = '';
        try {
          const response = await fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: token.value, password: password.value })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || response.statusText);
          location.reload();
        } catch (failure) {
          if (error) error.textContent = failure.message;
        }
      }, true);
    }
    if (logout) logout.addEventListener('click', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.reload();
    }, true);
  });
}
