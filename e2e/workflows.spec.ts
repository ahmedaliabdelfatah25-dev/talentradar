import { expect, test, type Page } from 'playwright/test';

/** Signs in through the demo panel on the login page (fictional accounts). */
async function signIn(page: Page, name: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
const main = (page: Page) => page.getByRole('main');

test.describe.configure({ mode: 'serial' });

test('leader lands on the overview and can see where every vacancy stands', async ({ page }) => {
  await signIn(page, 'Dina Abdelrahman');
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole('heading', { name: 'Egypt TA — recruitment overview' })).toBeVisible();
  for (const label of ['Active vacancies', 'On track', 'Needs attention', 'Blocked', 'On hold', 'Completed hires', 'Upcoming deadlines', 'Overdue actions']) {
    await expect(main(page).getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Requires intervention' })).toBeVisible();
  const rows = page.locator('table.data tbody tr');
  await expect(rows).toHaveCount(10);
  for (const col of ['Vacancy', 'Location', 'Department', 'Recruiter', 'Hiring manager', 'Current stage', 'Overall status', 'Last update', 'Next action', 'Action owner', 'Deadline']) {
    await expect(page.locator('table.data thead')).toContainText(col, { ignoreCase: true });
  }
  // KPI tile filters the tracker; filters narrow it further.
  await page.getByRole('button', { name: /Blocked/ }).first().click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Regional Sales Manager — KSA');
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByLabel('All recruiters').selectOption('Omar Farouk');
  await expect(rows).toHaveCount(3);
  await page.getByLabel('All countries').selectOption('Egypt');
  await expect(rows).toHaveCount(1);
  // A row opens the vacancy workspace.
  await rows.first().click();
  await expect(page).toHaveURL(/\/vacancies\/\d+/);
  await expect(page.getByRole('heading', { name: 'Head of Customer Success — MENA' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Recruitment milestones/ })).toBeVisible();
  await expect(page.getByText('Recruited by Egypt TA')).toBeVisible();
});

test('recruiter lands on their workspace and records a quick progress update', async ({ page }) => {
  await signIn(page, 'Nour El-Sayed');
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByText('Next priority')).toBeVisible();
  await expect(page.getByText('What I must update')).toBeVisible();
  await expect(page.getByText('My outstanding actions')).toBeVisible();
  const card = page.locator('div.glass', { hasText: 'Senior Account Executive — DACH' }).filter({ hasText: 'Update progress' }).last();
  await card.getByRole('button', { name: 'Update progress' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update progress' });
  await dialog.getByLabel('What changed?').fill('Second-round interviews held; candidate B is the preferred finalist.');
  await dialog.getByRole('button', { name: 'Awaiting feedback' }).click();
  await dialog.getByLabel('Current recruitment stage').selectOption({ label: 'Offer' });
  await dialog.getByLabel('Next action', { exact: true }).fill('Approve the offer package for candidate B');
  await dialog.getByLabel('Responsible person').fill('Markus Steiner');
  await dialog.getByLabel('Also add this next action to the Action Centre').check();
  await dialog.getByRole('button', { name: 'Save update' }).click();
  await expect(page.getByText('Progress update saved')).toBeVisible();
  await expect(card).toContainText('Awaiting feedback');
  await expect(card).toContainText('Approve the offer package for candidate B');

  await page.goto('/tracker');
  await page.getByPlaceholder('Filter this table…').fill('DACH');
  await page.locator('table.data tbody tr').first().click();
  await expect(page.getByText('Second-round interviews held; candidate B is the preferred finalist.').first()).toBeVisible();
  await expect(page.getByText('12 days in this stage')).toHaveCount(0);
  await expect(page.getByText(/0 days in this stage/)).toBeVisible();
  await page.getByRole('tab', { name: /Change history/ }).click();
  await expect(page.getByText('Recruitment stage:').first()).toBeVisible();
  await expect(main(page)).toContainText('Interviews');
});

test('leader sees the recruiter’s update without asking for it', async ({ page }) => {
  await signIn(page, 'Dina Abdelrahman');
  const row = page.locator('table.data tbody tr', { hasText: 'Senior Account Executive — DACH' });
  await expect(row).toContainText('Offer');
  await expect(row).toContainText('Awaiting feedback');
  await expect(row).toContainText('Approve the offer package for candidate B');
  await expect(row).toContainText('Markus Steiner');
});

test('recruiter creates a vacancy and customises its milestones', async ({ page }) => {
  await signIn(page, 'Laila Hassan');
  await page.getByRole('button', { name: 'New vacancy' }).click();
  const form = page.getByRole('dialog', { name: 'New vacancy' });
  await form.getByLabel('Job title').fill('Data Analyst — People Analytics');
  await form.getByLabel('Country (vacancy location)').selectOption({ label: 'Netherlands' });
  await form.getByLabel('City').fill('Amsterdam');
  await form.getByLabel('Hiring manager', { exact: true }).fill('Sanne de Vries');
  await form.getByLabel('Opening date').fill('2026-11-02');
  await form.getByRole('button', { name: 'Create vacancy' }).click();
  await expect(page.getByText('Vacancy created')).toBeVisible();
  await page.goto('/tracker');
  await page.getByPlaceholder('Filter this table…').fill('People Analytics');
  const row = page.locator('table.data tbody tr').first();
  await expect(row).toContainText('Netherlands');
  await expect(row).toContainText('Laila Hassan');
  await expect(row).not.toContainText('DEMO');
  await row.click();
  await expect(page.getByText('Recruited by Egypt TA')).toBeVisible();
  await page.getByRole('button', { name: 'Edit milestones' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit milestones' });
  await editor.getByRole('button', { name: 'Add milestone' }).click();
  await editor.getByLabel('Milestone name').last().fill('SQL case study');
  await editor.getByRole('button', { name: 'Save milestones' }).click();
  await expect(page.getByText('Milestones saved')).toBeVisible();
  await expect(main(page)).toContainText('SQL case study');
  await expect(main(page)).toContainText('0 of 10 complete');
});

test('action centre: create, find by bucket and complete an action', async ({ page }) => {
  await signIn(page, 'Laila Hassan');
  await page.goto('/actions');
  await page.getByRole('button', { name: 'New action' }).click();
  const drawer = page.getByRole('dialog', { name: 'New action' });
  await drawer.getByLabel('Action title').fill('Send salary benchmark to hiring manager');
  await drawer.getByLabel('Due date').fill('2026-01-05');
  await drawer.getByRole('button', { name: 'Create action' }).click();
  await expect(page.getByText('Action created')).toBeVisible();
  await page.getByRole('tab', { name: /Overdue/ }).click();
  const item = page.locator('li', { hasText: 'Send salary benchmark to hiring manager' });
  await expect(item).toContainText('Overdue');
  await item.getByRole('button', { name: /Mark .* as completed/ }).click();
  await expect(page.getByText('Action completed')).toBeVisible();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await expect(page.locator('li', { hasText: 'Send salary benchmark to hiring manager' })).toBeVisible();
});

test('risk monitor explains each alert', async ({ page }) => {
  await signIn(page, 'Dina Abdelrahman');
  await page.goto('/risks');
  await expect(page.getByText('What happened').first()).toBeVisible();
  await expect(page.getByText('Recommended action').first()).toBeVisible();
  await expect(page.getByText('Responsible').first()).toBeVisible();
  await page.getByLabel('Rule').selectOption({ label: 'No recent update' });
  await expect(main(page)).toContainText('Finance Business Partner');
  await expect(main(page)).toContainText('the threshold is 7 days');
});

test('leadership report: view, save to history and export PDF and CSV', async ({ page }) => {
  await signIn(page, 'Dina Abdelrahman');
  await page.goto('/reports');
  for (const s of ['Vacancies managed by Egypt TA', 'Changes since the previous report', 'Recruiter workload', 'Activities completed this week', 'Outstanding actions',
    'Overdue milestones', 'Recruitment blockers', 'Support required', 'Important upcoming deadlines']) await expect(page.getByRole('heading', { name: new RegExp(s) })).toBeVisible();
  await page.getByRole('button', { name: 'Save to history' }).click();
  await expect(page.getByText(/saved to history/)).toBeVisible();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/talent-radar-weekly-report-.*\.pdf$/);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'CSV' }).click()]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  await page.getByRole('tab', { name: /History and trends/ }).click();
  await expect(page.getByRole('heading', { name: 'Week by week' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Progressing or stagnating?' })).toBeVisible();
  await expect(page.getByText('This week · live')).toBeVisible();
});

test('assistant works without an AI service and shows its sources', async ({ page }) => {
  await signIn(page, 'Dina Abdelrahman');
  await page.goto('/assistant');
  await expect(page.getByText('Built-in engine only — no external AI service is used').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Leadership brief — Egypt TA/ })).toBeVisible();
  await expect(page.getByText('Where leadership attention is needed')).toBeVisible();
  await expect(page.getByText(/Risk rule “Vacancy is blocked”/).first()).toBeVisible();
  await page.getByRole('button', { name: /Reminder drafts/ }).click();
  await expect(page.getByText('Drafts only — nothing is sent by the application.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in mail' }).first()).toBeVisible();
});

test('Excel migration: upload, map, preview duplicates, import and get a validation report', async ({ page }) => {
  await signIn(page, 'Youssef Tarek');
  await page.goto('/import');
  const csv = ['Position;Country;Recruiter;Hiring Manager;Stage;Status;Latest Update;Next Step;Deadline',
    'Implementation Consultant;Germany;Karim Mansour;Lena Fischer;Interviews;On track;Panel booked for next week;Confirm panel members;20/12/2026',
    'Senior Account Executive — DACH;Austria;Nour El-Sayed;Somebody Else;Offer;Open;MUST NOT OVERWRITE;;',
    ';Egypt;;;;;row without a title;;'].join('\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'egypt-ta-tracker.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByRole('heading', { name: 'egypt-ta-tracker.csv' })).toBeVisible();
  await expect(page.getByLabel('Column for Job title')).toHaveValue('0');
  await expect(page.getByText('Matched by name').first()).toBeVisible();
  await page.getByRole('button', { name: /Preview import/ }).click();
  await expect(page.getByText('1 ready')).toBeVisible();
  await expect(page.getByText('1 duplicates')).toBeVisible();
  await expect(page.getByText('1 missing required information')).toBeVisible();
  await expect(page.getByText(/already in the tracker/)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Import 1 row' }).click();
  await expect(page.getByRole('heading', { name: 'Import completed' })).toBeVisible();
  await page.getByRole('button', { name: 'Open validation report' }).click();
  const report = page.getByRole('dialog', { name: 'Import validation report' });
  await expect(report).toContainText('Created');
  await expect(report).toContainText('Skipped — duplicate');
  await expect(report).toContainText('Skipped — error');
  await page.keyboard.press('Escape');
  await page.goto('/tracker');
  await page.getByPlaceholder('Filter this table…').fill('Implementation Consultant');
  await expect(page.locator('table.data tbody tr').first()).toContainText('Interviews');
  await page.getByPlaceholder('Filter this table…').fill('DACH');
  await expect(page.locator('table.data tbody tr').first()).not.toContainText('MUST NOT OVERWRITE');
});

test('administrator manages users and runs the simulated Greenhouse sync', async ({ page }) => {
  await signIn(page, 'Youssef Tarek');
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Add user' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add user' });
  await dlg.getByLabel('Full name').fill('Hana Mostafa');
  await dlg.getByLabel('Work email').fill('hana.mostafa@talentradar.example');
  await dlg.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('dialog', { name: 'Temporary password' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('table.data')).toContainText('Hana Mostafa');

  await page.getByRole('tab', { name: 'Integrations' }).click();
  await page.getByRole('button', { name: 'Synchronise now' }).click();
  await expect(page.getByText('Completed with issues').first()).toBeVisible();
  await expect(page.getByText(/was not returned by Greenhouse/)).toBeVisible();
  await expect(page.getByText('Open in Greenhouse but not in the tracker')).toBeVisible();

  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByLabel('Viewer: Update any vacancy')).not.toBeChecked();
  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.locator('table.data')).toContainText('Hana Mostafa');
});

test('viewer is read-only; theme switch works', async ({ page }) => {
  await signIn(page, 'Stefan Huber');
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole('button', { name: 'New vacancy' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  await page.locator('table.data tbody tr').first().click();
  await expect(page.getByRole('button', { name: 'Update progress' })).toHaveCount(0);
  await expect(page.getByText('Internal notes')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: /Switch theme/ });
  for (let i = 0; i < 3 && !(await page.locator('html.dark').count()); i++) await toggle.click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});
