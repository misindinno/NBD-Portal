// ─── ClientConfig.js — dashboard-portal ──────────────────────────────────────
// Read-only analytics portal. Connects to the consolidated dashboard sheet.

const CLIENT_CONFIG = {
  SPREADSHEET_ID:               '1twfrZgWZ7AiIWWJR95t5Onhqh5xZZOYZ6YrDrvIgq4w',
  NBD_TARGET_SPREADSHEET_ID:    '',
  USER_DATABASE_SPREADSHEET_ID: '1jFr5BFta-ry6mJ8GGOh1p0gk2vhCRs4bv-RayBfX4BA',
  USER_DATABASE_SHEET_NAME:     'Staff List',
  PORTAL_KEY:                   'DASH',
  PORTAL_KIND:                  'dashboard',
  APP_TITLE:                    'Dashboard Portal',
  UPLOAD_FOLDER_NAME:           'Dashboard Portal Uploads',
  // Read-only sources to aggregate for cross-portal analytics
  AGGREGATE_SOURCES: [
    { key: 'LQ',           name: 'LQ Portal',      spreadsheetId: '1LeALluP02bd37clVesulu1JY7HeJjVNA4J067-QUM5w' },
    { key: 'NBD',          name: 'NBD Portal',     spreadsheetId: '1X3ltwu9Etf9FjG2gxoCSHfw8sEDQcvXtWJTugEcUz8U' },
    { key: 'LQ_LAM',       name: 'LQ Lamination',  spreadsheetId: '1EKUMWJ_zyoPQ9tbV-PGySMFBm-jsbx6NWO9x6R6slK8' },
    { key: 'NBD_LAM',      name: 'NBD Lamination', spreadsheetId: '1_INBusaKi3TdGe-1MjlOdnTL-XdRdhWnBxwE5_3HBpw' }
  ],
  THEME: {
    PRIMARY:         '#4F46E5',
    PRIMARY_LIGHT:   '#6366F1',
    SB_FROM:         '#4338CA',
    SB_TO:           '#312E81',
    LO_ACC:          '#6366F1',
    LO_ACC_H:        '#4F46E5',
    LO_ACC2:         '#8B5CF6',
    LO_SOFT:         'rgba(99,102,241,0.10)',
    LO_GLOW_1:       'rgba(99,102,241,0.26)',
    LO_GLOW_2:       'rgba(139,92,246,0.18)',
    LO_GLOW_3:       'rgba(99,102,241,0.06)',
    LO_MARK_SHADOW:  'rgba(79,70,229,0.55)',
  }
};
