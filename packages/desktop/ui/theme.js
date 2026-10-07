const themePreference = localStorage.getItem('relay.theme');
document.documentElement.dataset.theme = themePreference === 'light' || themePreference === 'dark'
  ? themePreference
  : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
