/*-----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

import { IFrame } from '@jupyterlab/apputils';

import { ActivityMonitor } from '@jupyterlab/coreutils';

import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget,
  IDocumentWidget
} from '@jupyterlab/docregistry';

import '../style/index.css';

/**
 * The timeout to wait for change activity to have ceased before rendering.
 */
const RENDER_TIMEOUT = 1000;

/**
 * The CSS class to add to the HTMLViewer Widget.
 */
const CSS_CLASS = 'jp-HTMLViewer';

/**
 * A viewer widget for HTML documents.
 *
 * #### Notes
 * The iframed HTML document can pose a potential security risk,
 * since it can execute Javascript, and make same-origin requests
 * to the server, thereby executing arbitrary Javascript.
 *
 * Here, we sandbox the iframe so that it can't execute Javsacript
 * or launch any popups. We allow one exception: 'allow-same-origin'
 * requests, so that local HTML documents can access CSS, images,
 * etc from the files system.
 */
export class HTMLViewer extends DocumentWidget<IFrame>
  implements IDocumentWidget<IFrame> {
  /**
   * Create a new widget for rendering HTML.
   */
  constructor(options: DocumentWidget.IOptionsOptionalContent) {
    super({
      ...options,
      content: new IFrame({
        sandbox: true,
        exceptions: ['allow-same-origin']
      })
    });
    this.content.addClass(CSS_CLASS);

    this.context.ready.then(() => {
      this.update();
      // Throttle the rendering rate of the widget.
      this._monitor = new ActivityMonitor({
        signal: this.context.model.contentChanged,
        timeout: RENDER_TIMEOUT
      });
      this._monitor.activityStopped.connect(
        this.update,
        this
      );
    });
  }

  /**
   * Handle and update request.
   */
  protected onUpdateRequest(): void {
    if (this._renderPending) {
      return;
    }
    this._renderPending = true;
    this._renderModel().then(() => (this._renderPending = false));
  }

  /**
   * Render HTML in IFrame into this widget's node.
   */
  private async _renderModel(): Promise<void> {
    let data = this.context.model.toString();
    data = await this._setBase(data);

    // Set the new iframe url.
    const blob = new Blob([data], { type: 'text/html' });
    const oldUrl = this._objectUrl;
    this._objectUrl = URL.createObjectURL(blob);
    this.content.url = this._objectUrl;

    // Release reference to any previous object url.
    if (oldUrl) {
      try {
        URL.revokeObjectURL(oldUrl);
      } catch (error) {
        /* no-op */
      }
    }
    return;
  }

  /**
   * Set a <base> element in the HTML string so that the iframe
   * can correctly dereference relative links.
   */
  private async _setBase(data: string): Promise<string> {
    const doc = this._parser.parseFromString(data, 'text/html');
    let base: HTMLBaseElement;
    base = doc.querySelector('base');
    if (!base) {
      base = doc.createElement('base');
      doc.head.insertBefore(base, doc.head.firstChild);
    }
    const path = this.context.path;
    const baseUrl = await this.context.urlResolver.getDownloadUrl(path);

    // Set the base href, plus a fake name for the url of this
    // document. The fake name doesn't really matter, as long
    // as the document can dereference relative links to resources
    // (e.g. CSS and scripts).
    base.href = baseUrl;
    base.target = '_self';
    return doc.documentElement.innerHTML;
  }

  private _renderPending = false;
  private _parser = new DOMParser();
  private _monitor: ActivityMonitor<any, any> | null = null;
  private _objectUrl: string = '';
}

/**
 * A widget factory for HTMLViewers.
 */
export class HTMLViewerFactory extends ABCWidgetFactory<HTMLViewer> {
  /**
   * Create a new widget given a context.
   */
  protected createNewWidget(context: DocumentRegistry.Context): HTMLViewer {
    return new HTMLViewer({ context });
  }
}
