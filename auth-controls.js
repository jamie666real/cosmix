(function () {
  const STORAGE_KEY = 'cosmix-profile-users';
  const CURRENT_USER_KEY = 'cosmix-profile-current-user';

  function normalizeUser(user) {
    const normalized = user || {};
    return {
      id: normalized.id || '',
      username: String(normalized.username || '').trim() || 'Profile',
      email: String(normalized.email || '').trim().toLowerCase(),
      password: String(normalized.password || ''),
      avatar: normalized.avatar || '',
      role: normalized.role || 'member',
      roles: Array.isArray(normalized.roles) ? normalized.roles : [],
      permissions: Array.isArray(normalized.permissions) ? normalized.permissions : [],
      deleteRequested: Boolean(normalized.deleteRequested),
      deleteReason: normalized.deleteReason || '',
    };
  }

  function getCurrentUser() {
    try {
      const raw = localStorage.getItem(CURRENT_USER_KEY);
      return raw ? normalizeUser(JSON.parse(raw)) : null;
    } catch (error) {
      return null;
    }
  }

  function clearCurrentUser() {
    localStorage.removeItem(CURRENT_USER_KEY);
  }

  function getStoredUsers() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function renderAuthControls() {
    const containers = document.querySelectorAll('.auth-controls');
    const currentUser = getCurrentUser();

    containers.forEach((container) => {
      if (!container) return;

      if (currentUser) {
        const roles = Array.isArray(currentUser.roles) ? currentUser.roles : [];
        const isOwner = roles.includes('owner') || currentUser.role === 'owner' || currentUser.isOwner;
        const isStaff = isOwner || currentUser.role === 'staff' || currentUser.role === 'admin' || roles.includes('staff') || roles.includes('admin');
        const extraLinks = isStaff
          ? '<a class="button secondary small" href="staff.html">Staff</a><a class="button secondary small" href="reports.html">Reports</a>'
          : '';
        const ownerUsersLink = isOwner ? '<a class="button secondary small" href="owner-users.html">Owner users</a>' : '';
        container.innerHTML = `<a class="button secondary small" href="/profile.html">${currentUser.username || 'Profile'}</a>${extraLinks}${ownerUsersLink}<button class="button secondary small" id="signout-button" type="button">Sign out</button>`;
        const signoutButton = container.querySelector('#signout-button');
        if (signoutButton) {
          signoutButton.addEventListener('click', () => {
            clearCurrentUser();
            renderAuthControls();
          });
        }
      } else {
        const profileHref = window.location.pathname.includes('/eaglercraft/') ? '../profile.html' : '/profile.html';
        const rootHref = window.location.pathname.includes('/eaglercraft/') ? '../profile.html?view=signup' : '/profile.html?view=signup';
        container.innerHTML = `<a class="button secondary small" href="${profileHref}">Sign in</a><a class="button secondary small" href="${rootHref}">Sign up</a>`;
      }
    });
  }

  window.renderAuthControls = renderAuthControls;
  window.addEventListener('load', renderAuthControls);
  window.addEventListener('storage', renderAuthControls);
  document.addEventListener('DOMContentLoaded', renderAuthControls);
})();
