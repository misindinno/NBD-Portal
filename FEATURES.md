# NBD Portal — Feature Roadmap

> Captured: 2026-05-09
> Status key: 🔲 Planned · 🔄 In Progress · ✅ Done

---

## Current System (Baseline)

| Module | Description |
|--------|-------------|
| Dashboard | KPI cards, pipeline funnel, follow-up donut, source analytics, team performance, lead health score, overdue tables, activity timeline |
| Follow Up | All / Today / Overdue / Custom tabs, mark done, follow-up history |
| Pipeline | Kanban drag-and-drop with stage field requirements |
| Lead Master | Table with filters, add/edit/delete, lead detail drawer |
| Lead Form | Standalone page for field sales (shareable link) |
| Config | Stages, custom fields, dropdown lists, portal settings |
| Users | User management with roles (ADMIN, MANAGER, SALES, USER, VIEWER) |

---

## 📊 Reports & Analytics

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| R1 | Export leads / follow-ups to CSV or Excel | Low | High | 🔲 |
| R2 | Custom date-range report builder | Medium | High | 🔲 |
| R3 | Stage conversion funnel over time (trend chart, not just snapshot) | Medium | Medium | 🔲 |
| R4 | Time-in-stage tracking — how long a lead sits in each stage | Medium | High | 🔲 |
| R5 | Win / Loss reason tracking with breakdown chart | Low | High | 🔲 |
| R6 | Daily / weekly digest email via Apps Script time trigger | Medium | High | 🔲 |
| R7 | Month-over-month KPI comparison (leads, conversions, follow-ups) | Medium | Medium | 🔲 |
| R8 | Product interest analytics — which products are winning / losing | Low | Medium | 🔲 |

---

## 📋 Lead Management

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| L1 | Bulk CSV / Excel import of leads | Medium | High | 🔲 |
| L2 | Duplicate detection — warn if same phone, email, or GST already exists | Medium | High | 🔲 |
| L3 | Bulk lead reassignment — select many leads, assign to a salesperson | Low | High | 🔲 |
| L4 | Lead tagging / custom labels (e.g. Hot, VIP, Follow Next Month) | Low | Medium | 🔲 |
| L5 | Lead transfer history — track who owned the lead before | Low | Medium | 🔲 |
| L6 | Multiple contacts per company (Contact book inside a lead) | High | Medium | 🔲 |
| L7 | Merge duplicate leads | High | Medium | 🔲 |
| L8 | Win / Loss reason field when closing a lead | Low | High | 🔲 |
| L9 | Lead age indicator — how many days since the lead was created | Low | Medium | 🔲 |

---

## 📞 Follow-up Enhancements

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| F1 | Recurring follow-up templates (e.g. every 7 days automatically) | Medium | High | 🔲 |
| F2 | Follow-up reminder notifications — browser push or email alert | Medium | High | 🔲 |
| F3 | Calendar view of follow-ups — monthly / weekly grid layout | Medium | High | 🔲 |
| F4 | Assign a follow-up to a different user than the lead owner | Low | Medium | 🔲 |
| F5 | Follow-up text templates — pre-filled discussion text | Low | Medium | 🔲 |
| F6 | Bulk mark follow-ups done | Low | Medium | 🔲 |

---

## 🔔 Notifications & Automation

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| A1 | Email alert for overdue follow-ups — daily Apps Script time trigger at 9am | Low | High | 🔲 |
| A2 | Auto-assign leads by round-robin or territory / state rules | Medium | High | 🔲 |
| A3 | Stage-based auto-tasks — auto-create a follow-up when a lead moves to a stage | Medium | High | 🔲 |
| A4 | WhatsApp message trigger on lead creation or stage change | High | High | 🔲 |
| A5 | Inactivity alert — flag leads not touched in N days (configurable) | Low | High | 🔲 |
| A6 | New lead assignment notification to the assigned salesperson | Low | High | 🔲 |

---

## 🔍 Search & UX

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| U1 | Global search bar — search across all leads, companies, remarks, contacts | Medium | High | 🔲 |
| U2 | Saved / pinned filters per user (save current filter set with a name) | Medium | Medium | 🔲 |
| U3 | Column picker in Lead Master table — show / hide / reorder columns | Low | Medium | 🔲 |
| U4 | Keyboard shortcuts — N = new lead, F = add follow-up, / = search | Low | Low | 🔲 |
| U5 | In-app notification bell — unread activity feed | Medium | Medium | 🔲 |
| U6 | Dark mode | Low | Low | 🔲 |
| U7 | Quick-edit inline in Lead Master table (edit cell directly) | Medium | Medium | 🔲 |

---

## 🔗 Integrations

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| I1 | Google Forms → auto-create lead via Apps Script trigger | Low | High | 🔲 |
| I2 | Google Calendar sync — follow-up dates appear as calendar events | Medium | High | 🔲 |
| I3 | IndiaMart / Justdial / website form auto lead capture (webhook) | Medium | High | 🔲 |
| I4 | WhatsApp Business API — send messages from lead detail page | High | High | 🔲 |
| I5 | Google Contacts sync — import contacts as leads | High | Low | 🔲 |
| I6 | Zapier / Make webhook endpoint — connect to any external tool | Medium | Medium | 🔲 |

---

## 📱 Mobile & Offline

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| M1 | PWA support — add to home screen, offline data cache | Medium | High | 🔲 |
| M2 | Mobile-optimised lead card view with swipe actions (call, follow-up) | Medium | Medium | 🔲 |
| M3 | GPS check-in for visit follow-ups — store location with follow-up | High | Medium | 🔲 |

---

## 👥 Team & Access

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| T1 | Team hierarchy — manager sees only their direct team's leads | Medium | High | 🔲 |
| T2 | Monthly target vs actual tracker per salesperson | Medium | High | 🔲 |
| T3 | Audit log viewer in UI — who changed what, and when | Low | Medium | 🔲 |
| T4 | User-level notification preferences (email / browser / none) | Low | Low | 🔲 |
| T5 | Login activity log — track last login per user | Low | Low | 🔲 |

---

## ⭐ Top 5 Quick Wins

These deliver the most value for the least effort and should be done first.

| Priority | ID | Feature |
|----------|----|---------|
| 1 | L8 | Win / Loss reason field when closing a lead |
| 2 | L2 | Duplicate detection on phone / email / GST |
| 3 | R1 | CSV / Excel export from Lead Master |
| 4 | A1 | Overdue follow-up daily email digest |
| 5 | A5 | Inactivity alert — leads not touched in N days |

---

## Effort Guide

| Label | Meaning |
|-------|---------|
| Low | 1–2 days, limited files touched |
| Medium | 3–5 days, new screens or server functions needed |
| High | 1–2 weeks, significant architecture or third-party integration |
