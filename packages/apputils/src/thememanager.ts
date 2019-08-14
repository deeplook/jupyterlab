// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IChangedArgs, ISettingRegistry, URLExt } from '@jupyterlab/coreutils';

import { each } from '@phosphor/algorithm';

import { DisposableDelegate, IDisposable } from '@phosphor/disposable';

import { Widget } from '@phosphor/widgets';

import { ISignal, Signal } from '@phosphor/signaling';

import { Dialog, showDialog } from './dialog';

import { ISplashScreen } from './splash';

import { IThemeManager } from './tokens';

/**
 * The number of milliseconds between theme loading attempts.
 */
const REQUEST_INTERVAL = 75;

/**
 * The number of times to attempt to load a theme before giving up.
 */
const REQUEST_THRESHOLD = 20;

type Dict<T> = { [key: string]: T };

/**
 * A class that provides theme management.
 */
export class ThemeManager implements IThemeManager {
  /**
   * Construct a new theme manager.
   */
  constructor(options: ThemeManager.IOptions) {
    const { host, key, splash, url } = options;
    const registry = options.settings;

    this._base = url;
    this._host = host;
    this._splash = splash || null;

    void registry.load(key).then(settings => {
      this._settings = settings;
      this._settings.changed.connect(this._loadSettings, this);
      this._loadSettings();
    });
  }

  /**
   * Get the name of the current theme.
   */
  get theme(): string | null {
    return this._current;
  }

  /**
   * The names of the registered themes.
   */
  get themes(): ReadonlyArray<string> {
    return Object.keys(this._themes);
  }

  /**
   * A signal fired when the application theme changes.
   */
  get themeChanged(): ISignal<this, IChangedArgs<string>> {
    return this._themeChanged;
  }

  /**
   * Get the value of a CSS variable from its key.
   *
   * @param key - A Jupyterlab CSS variable, without the leading '--jp-'.
   */
  getCSS(key: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(
      `--jp-${key}`
    );
  }

  /**
   * Load a theme CSS file by path.
   *
   * @param path - The path of the file to load.
   */
  loadCSS(path: string): Promise<void> {
    const base = this._base;
    const href = URLExt.isLocal(path) ? URLExt.join(base, path) : path;
    const links = this._links;

    return new Promise((resolve, reject) => {
      const link = document.createElement('link');

      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('type', 'text/css');
      link.setAttribute('href', href);
      link.addEventListener('load', () => {
        resolve(undefined);
      });
      link.addEventListener('error', () => {
        reject(`Stylesheet failed to load: ${href}`);
      });

      document.body.appendChild(link);
      links.push(link);
    });
  }

  /**
   * Loads all current CSS overrides from settings. If an override has been
   * removed or is invalid, this function unloads it instead.
   */
  loadCSSOverrides(): void {
    const newOverrides =
      (this._settings.user['overrides'] as Dict<string>) || {};

    // iterate over the union of current and new CSS override keys
    Object.keys({ ...this._overrides, ...newOverrides }).forEach(key => {
      if (newOverrides[key]) {
        // if key is present in newOverrides, validate then set the override
        if (ThemeManager.validateCSS(key, newOverrides[key])) {
          document.documentElement.style.setProperty(
            `--jp-${key}`,
            newOverrides[key]
          );
        } else {
          // if validation failed, the override will be removed
          document.documentElement.style.removeProperty(`--jp-${key}`);
        }
      } else {
        // if key is not present, the override will be removed
        document.documentElement.style.removeProperty(`--jp-${key}`);
      }
    });

    // replace the current overrides with the new ones
    this._overrides = newOverrides;
  }

  /**
   * Register a theme with the theme manager.
   *
   * @param theme - The theme to register.
   *
   * @returns A disposable that can be used to unregister the theme.
   */
  register(theme: IThemeManager.ITheme): IDisposable {
    const { name } = theme;
    const themes = this._themes;

    if (themes[name]) {
      throw new Error(`Theme already registered for ${name}`);
    }

    themes[name] = theme;

    return new DisposableDelegate(() => {
      delete themes[name];
    });
  }

  /**
   * Add a CSS override to the settings.
   */
  setCSSOverride(key: string, value: string): Promise<void> {
    this._overrides[key] = value;
    return this._settings.set('overrides', this._overrides);
  }

  /**
   * Set the current theme.
   */
  setTheme(name: string): Promise<void> {
    return this._settings.set('theme', name);
  }

  /**
   * Test whether a given theme is light.
   */
  isLight(name: string): boolean {
    return this._themes[name].isLight;
  }

  /**
   * Increase a font size w.r.t. its current setting or its value in the
   * current theme.
   *
   * @param key - A Jupyterlab font size CSS variable, without the leading '--jp-'.
   */
  incrFontSize(key: string): Promise<void> {
    return this._incrFontSize(key, true);
  }

  /**
   * Decrease a font size w.r.t. its current setting or its value in the
   * current theme.
   *
   * @param key - A Jupyterlab font size CSS variable, without the leading '--jp-'.
   */
  decrFontSize(key: string): Promise<void> {
    return this._incrFontSize(key, false);
  }

  /**
   * Test whether a given theme styles scrollbars,
   * and if the user has scrollbar styling enabled.
   */
  themeScrollbars(name: string): boolean {
    return (
      !!this._settings.composite['theme-scrollbars'] &&
      !!this._themes[name].themeScrollbars
    );
  }

  /**
   * Toggle the `theme-scrollbbars` setting.
   */
  toggleThemeScrollbars(): Promise<void> {
    return this._settings.set(
      'theme-scrollbars',
      !this._settings.composite['theme-scrollbars']
    );
  }

  /**
   * Change a font size by a positive or negative increment.
   */
  private _incrFontSize(key: string, add: boolean = true): Promise<void> {
    // get the numeric and unit parts of the current font size
    const parts = (this.getCSS(key) || '13px').split(/([a-zA-Z]+)/);

    // determine the increment
    const incr = (add ? 1 : -1) * (parts[1] === 'em' ? 0.1 : 1);

    // increment the font size and set it as an override
    return this.setCSSOverride(key, `${Number(parts[0]) + incr}${parts[1]}`);
  }

  /**
   * Handle the current settings.
   */
  private _loadSettings(): void {
    const outstanding = this._outstanding;
    const pending = this._pending;
    const requests = this._requests;

    // If another request is pending, cancel it.
    if (pending) {
      window.clearTimeout(pending);
      this._pending = 0;
    }

    const settings = this._settings;
    const themes = this._themes;
    const theme = settings.composite['theme'] as string;

    // If another promise is outstanding, wait until it finishes before
    // attempting to load the settings. Because outstanding promises cannot
    // be aborted, the order in which they occur must be enforced.
    if (outstanding) {
      outstanding
        .then(() => {
          this._loadSettings();
        })
        .catch(() => {
          this._loadSettings();
        });
      this._outstanding = null;
      return;
    }

    // Increment the request counter.
    requests[theme] = requests[theme] ? requests[theme] + 1 : 1;

    // If the theme exists, load it right away.
    if (themes[theme]) {
      this._outstanding = this._loadTheme(theme);
      delete requests[theme];
      return;
    }

    // If the request has taken too long, give up.
    if (requests[theme] > REQUEST_THRESHOLD) {
      const fallback = settings.default('theme') as string;

      // Stop tracking the requests for this theme.
      delete requests[theme];

      if (!themes[fallback]) {
        this._onError(`Neither theme ${theme} nor default ${fallback} loaded.`);
        return;
      }

      console.warn(`Could not load theme ${theme}, using default ${fallback}.`);
      this._outstanding = this._loadTheme(fallback);
      return;
    }

    // If the theme does not yet exist, attempt to wait for it.
    this._pending = window.setTimeout(() => {
      this._loadSettings();
    }, REQUEST_INTERVAL);
  }

  /**
   * Load the theme.
   *
   * #### Notes
   * This method assumes that the `theme` exists.
   */
  private _loadTheme(theme: string): Promise<void> {
    const current = this._current;
    const links = this._links;
    const themes = this._themes;
    const splash = this._splash
      ? this._splash.show(themes[theme].isLight)
      : new DisposableDelegate(() => undefined);

    // Unload any CSS files that have been loaded.
    links.forEach(link => {
      if (link.parentElement) {
        link.parentElement.removeChild(link);
      }
    });
    links.length = 0;

    // Unload the previously loaded theme.
    const old = current ? themes[current].unload() : Promise.resolve();

    return Promise.all([old, themes[theme].load()])
      .then(() => {
        this._current = theme;
        this._themeChanged.emit({
          name: 'theme',
          oldValue: current,
          newValue: theme
        });

        // Need to force a redraw of the app here to avoid a Chrome rendering
        // bug that can leave the scrollbars in an invalid state
        this._host.hide();

        // If we hide/show the widget too quickly, no redraw will happen.
        // requestAnimationFrame delays until after the next frame render.
        requestAnimationFrame(() => {
          this._host.show();
          Private.fitAll(this._host);
          splash.dispose();
        });
      })
      .catch(reason => {
        this._onError(reason);
        splash.dispose();
      });
  }

  /**
   * Handle a theme error.
   */
  private _onError(reason: any): void {
    void showDialog({
      title: 'Error Loading Theme',
      body: String(reason),
      buttons: [Dialog.okButton({ label: 'OK' })]
    });
  }

  private _base: string;
  private _current: string | null = null;
  private _host: Widget;
  private _links: HTMLLinkElement[] = [];
  private _overrides: Dict<string> = {};
  private _outstanding: Promise<void> | null = null;
  private _pending = 0;
  private _requests: { [theme: string]: number } = {};
  private _settings: ISettingRegistry.ISettings;
  private _splash: ISplashScreen | null;
  private _themes: { [key: string]: IThemeManager.ITheme } = {};
  private _themeChanged = new Signal<this, IChangedArgs<string>>(this);
}

export namespace ThemeManager {
  /**
   * The options used to create a theme manager.
   */
  export interface IOptions {
    /**
     * The host widget for the theme manager.
     */
    host: Widget;

    /**
     * The setting registry key that holds theme setting data.
     */
    key: string;

    /**
     * The settings registry.
     */
    settings: ISettingRegistry;

    /**
     * The splash screen to show when loading themes.
     */
    splash?: ISplashScreen;

    /**
     * The url for local theme loading.
     */
    url: string;
  }

  /**
   * Some basic CSS properties, corresponding to the naming
   * conventions of theme CSS variables
   */
  const cssProps = ['color', 'font-family', 'size'];

  /**
   * Validate a CSS value w.r.t. a key
   *
   * @param key - A Jupyterlab CSS variable, without the leading '--jp-'.
   *
   * @param val - A candidate CSS value
   */
  export const validateCSS = (key: string, val: string): boolean => {
    // determine the css property corresponding to the key
    let prop: string;
    for (const p of cssProps) {
      if (key.includes(p)) {
        prop = p;
        break;
      }
    }

    if (!prop) {
      console.warn(
        'CSS validation failed: could not find property corresponding to key.\n' +
          `key: '${key}', val: '${val}'`
      );
      return false;
    }

    // use built-in validation once we have the corresponding property
    if (CSS.supports(prop, val)) {
      return true;
    } else {
      console.warn(
        'CSS validation failed: invalid value.\n' +
          `key: '${key}', val: '${val}', prop: '${prop}'`
      );
      return false;
    }
  };
}

/**
 * A namespace for module private data.
 */
namespace Private {
  /**
   * Fit a widget and all of its children, recursively.
   */
  export function fitAll(widget: Widget): void {
    each(widget.children(), fitAll);
    widget.fit();
  }
}
