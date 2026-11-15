import { attemptDomScanHealing } from './healing.mjs';

export class SelectorFailureError extends Error {
  constructor(details) {
    super(details.message);
    this.name = 'SelectorFailureError';
    this.selectorSet = details.selectorSet;
    this.stepDescription = details.stepDescription;
    this.attemptedStrategies = details.attemptedStrategies;
  }
}

export function parseSelectorSet(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return { cssSelector: input };
    }
  }
  return input;
}

export class SelectorResolver {
  constructor(options = {}) {
    this.defaultTimeout = options.defaultTimeout || 3000;
    this.lastResolvedLayer = '';
    this.lastHealed = false;
  }

  async resolve(page, selectorSetInput, stepDescription = '', step = {}) {
    const set = parseSelectorSet(selectorSetInput);
    this.lastResolvedLayer = '';
    this.lastHealed = false;

    if (!set) {
      // If no selectorSet provided, check if step has simple selector
      if (step.selector) {
        try {
          const loc = page.locator(step.selector);
          await loc.waitFor({ state: 'attached', timeout: this.defaultTimeout });
          this.lastResolvedLayer = 'DIRECT_SELECTOR';
          return { locator: loc.first(), layerUsed: 'DIRECT_SELECTOR', healed: false };
        } catch {}
      }
      throw new SelectorFailureError({
        selectorSet: {},
        stepDescription,
        attemptedStrategies: [],
        message: 'No selectorSet or selector provided for step',
      });
    }

    const strategies = [
      {
        name: 'PRIMARY',
        label: 'data-testid/data-cy/data-qa',
        try: () => (set.primarySelector ? page.locator(set.primarySelector) : null),
        timeout: this.defaultTimeout,
      },
      {
        name: 'ARIA',
        label: 'aria role + name',
        try: () => {
          if (!set.ariaSelector || !set.ariaSelector.role) return null;
          return page.getByRole(set.ariaSelector.role, {
            name: set.ariaSelector.name,
            exact: false,
          });
        },
        timeout: this.defaultTimeout,
      },
      {
        name: 'TEXT',
        label: 'visible text content',
        try: () => (set.textSelector ? page.getByText(set.textSelector, { exact: false }) : null),
        timeout: this.defaultTimeout,
      },
      {
        name: 'CSS',
        label: 'CSS selector',
        try: () => (set.cssSelector ? page.locator(set.cssSelector) : null),
        timeout: this.defaultTimeout,
      },
      {
        name: 'XPATH',
        label: 'XPath selector',
        try: () => (set.xpathSelector ? page.locator(`xpath=${set.xpathSelector}`) : null),
        timeout: this.defaultTimeout,
      },
    ];

    const errors = [];

    // Attempt standard 5 layers
    for (const strategy of strategies) {
      let locator = null;
      try {
        locator = strategy.try();
      } catch (err) {
        errors.push(`${strategy.name} (construct): ${err.message}`);
        continue;
      }
      if (!locator) continue;

      try {
        await locator.waitFor({ state: 'attached', timeout: strategy.timeout });
        const count = await locator.count();
        if (count === 0) {
          throw new Error('0 matching elements found');
        }

        if (count > 1) {
          const narrowed = await this.narrowByContext(page, locator, set.domContext);
          if (narrowed) {
            this.lastResolvedLayer = `${strategy.name}_NARROWED`;
            return {
              locator: narrowed.first(),
              layerUsed: this.lastResolvedLayer,
              healed: false,
            };
          }
        }

        this.lastResolvedLayer = strategy.name;
        return {
          locator: locator.first(),
          layerUsed: strategy.name,
          healed: false,
        };
      } catch (err) {
        errors.push(`${strategy.name}: ${err.message}`);
      }
    }

    // LAYER 6A: Deterministic DOM Scanning fallback
    try {
      const healed = await attemptDomScanHealing(page, {
        description: stepDescription || step.description,
        ...step,
      });

      if (healed && healed.selector) {
        const healedLoc = page.locator(healed.selector);
        await healedLoc.waitFor({ state: 'attached', timeout: this.defaultTimeout });
        if ((await healedLoc.count()) > 0) {
          this.lastResolvedLayer = 'DOM_SCAN_HEALED';
          this.lastHealed = true;
          return {
            locator: healedLoc.first(),
            layerUsed: 'DOM_SCAN_HEALED',
            healed: true,
            strategy: healed.strategy,
            confidence: healed.confidence,
            healedSelector: healed.selector,
          };
        }
      }
    } catch (err) {
      errors.push(`DOM_SCAN: ${err.message}`);
    }

    // All layers failed
    throw new SelectorFailureError({
      selectorSet: set,
      stepDescription,
      attemptedStrategies: errors,
      message: `Could not resolve element for step "${stepDescription}" using any of 5 selector layers or DOM scan healing.`,
    });
  }

  async narrowByContext(page, locator, domContext) {
    if (!domContext) return null;

    // Narrow by region
    if (domContext.region && domContext.region !== 'body') {
      try {
        const regionContainer = page.locator(domContext.region);
        if ((await regionContainer.count()) > 0) {
          const scoped = locator.filter({ has: regionContainer });
          if ((await scoped.count()) === 1) return scoped;
        }
      } catch {}
    }

    // Narrow by nearby heading
    if (domContext.nearbyHeading) {
      try {
        const heading = page.getByRole('heading', {
          name: domContext.nearbyHeading,
          exact: false,
        });
        if ((await heading.count()) > 0) {
          const section = heading.locator('..');
          const scoped = section.locator(locator);
          if ((await scoped.count()) === 1) return scoped;
        }
      } catch {}
    }

    // Narrow by associated label
    if (domContext.label) {
      try {
        const lbl = page.locator(`label:has-text("${domContext.label}")`);
        if ((await lbl.count()) > 0) {
          const inputInLabel = lbl.locator('input, textarea, select');
          if ((await inputInLabel.count()) === 1) return inputInLabel;
        }
      } catch {}
    }

    return null;
  }
}
