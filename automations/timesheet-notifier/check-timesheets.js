const { chromium } = require("playwright");

async function checkTimesheets() {
  const credentials = {
    TIMEPRO_CID: (process.env.TIMEPRO_CID || "").trim(),
    TIMEPRO_USER: (process.env.TIMEPRO_USER || "").trim(),
    TIMEPRO_PWD: (process.env.TIMEPRO_PWD || "").trim(),
  };

  const required = ["TIMEPRO_CID", "TIMEPRO_USER", "TIMEPRO_PWD"];
  const missing = required.filter((key) => !credentials[key]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const headless = process.env.PW_HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1) Login via the TimePro login form.
    await page.goto("https://www.timesheets.com.au/tplogin/default.asp", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.locator('input[name="SystemID"]').fill(credentials.TIMEPRO_CID);
    await page.locator('input[name="UserName"]').fill(credentials.TIMEPRO_USER);
    await page.locator('input[name="password"]').fill(credentials.TIMEPRO_PWD);

    await page.locator('input[type="submit"][name="logon"]').click();
    await page.waitForLoadState("domcontentloaded");

    const loginRejected = await page
      .getByText(/logon details you supplied have not been accepted/i)
      .isVisible()
      .catch(() => false);

    if (loginRejected) {
      throw new Error(
        "TimePro login rejected credentials. Verify TIMEPRO_CID, TIMEPRO_USER, and TIMEPRO_PWD are correct for this customer.",
      );
    }

    // 2) Open Check Time via menu click (required by this app flow).
    if (!/\/Admin\/checktimes\.asp/i.test(page.url())) {
      const checkLink = page
        .locator(
          'a[href*="Admin/checktimes.asp"], a[href*="admin/checktimes.asp"]',
        )
        .first();

      await checkLink.waitFor({ state: "visible", timeout: 60_000 });
      await checkLink.click({ timeout: 60_000 });
    }

    await page.waitForURL(/\/Admin\/checktimes\.asp/i, { timeout: 60_000 });

    // 3) Scrape staff with no hours entered for today's column.
    const result = await page.evaluate(() => {
      const normalize = (text) => (text || "").replace(/\s+/g, "");
      const allRows = Array.from(document.querySelectorAll("tr"));

      // Use direct row cells to avoid nested table text polluting column indexes.
      const headerIndex = allRows.findIndex((row) => {
        const cells = Array.from(row.cells).map((cell) =>
          normalize(cell.textContent),
        );
        const hasDayColumn = cells.some((value) =>
          /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}[A-Za-z]{3}$/i.test(value),
        );
        return (
          cells.length > 10 &&
          hasDayColumn &&
          cells.includes("Status") &&
          cells.includes("StaffName") &&
          cells.includes("Total")
        );
      });

      if (headerIndex < 0) {
        throw new Error("Could not locate timesheet summary header row");
      }

      const headerCells = Array.from(allRows[headerIndex].cells).map((cell) =>
        normalize(cell.textContent),
      );

      const now = new Date();
      const day = now.toLocaleDateString("en-AU", {
        weekday: "short",
        timeZone: "Australia/Perth",
      });
      const dd = now.toLocaleDateString("en-AU", {
        day: "2-digit",
        timeZone: "Australia/Perth",
      });
      const mon = now.toLocaleDateString("en-AU", {
        month: "short",
        timeZone: "Australia/Perth",
      });
      const todayKey = `${day}${dd}${mon}`.toLowerCase();

      const dateColIndex = headerCells.findIndex(
        (value) => value.toLowerCase() === todayKey,
      );

      if (dateColIndex < 0) {
        throw new Error(
          `Could not locate today's column (${day} ${dd} ${mon})`,
        );
      }

      const missingToday = [];
      for (const row of allRows.slice(headerIndex + 1)) {
        const cells = Array.from(row.cells);
        if (cells.length <= dateColIndex || cells.length < 4) {
          continue;
        }

        const nameLink = cells[2].querySelector(
          'a[href*="SubmitViewTimesheet"]',
        );
        if (!nameLink) {
          continue;
        }

        const name = (nameLink.textContent || "").trim();
        if (!name) {
          continue;
        }

        const hoursToday = (cells[dateColIndex].textContent || "")
          .replace(/\u00a0/g, " ")
          .trim();

        if (!hoursToday) {
          missingToday.push(name);
        }
      }

      return {
        todayColumn: `${day} ${dd} ${mon}`,
        missingToday,
      };
    });

    console.log(
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          todayColumn: result.todayColumn,
          missingCount: result.missingToday.length,
          missing: result.missingToday,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await page.screenshot({ path: "timesheets-debug.png", fullPage: true });
    throw err;
  } finally {
    await browser.close();
  }
}

checkTimesheets();
