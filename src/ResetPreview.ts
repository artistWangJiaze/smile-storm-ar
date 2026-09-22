// Explicit local-preview reset. Consume the flag before initializing guides.
const resetURL = new URL(location.href);
if (['localhost', '127.0.0.1'].includes(location.hostname) && resetURL.searchParams.get('resetPreview') === '1') {
  try {
    localStorage.removeItem('smile-storm:onboarding:figma-v1');
    localStorage.removeItem('smile-storm:easter-egg:v1');
    resetURL.searchParams.delete('resetPreview');
    history.replaceState(null, '', resetURL);
  } catch { console.warn('Unable to reset preview guide storage.'); }
}
