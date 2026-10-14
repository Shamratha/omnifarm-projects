/**
 * Builds a webpack compilation from a configuration.
 *
 * The callback overload starts the build asynchronously and reports the
 * resulting statistics when it completes.
 *
 * @example
 * const compiler = webpack({ entry: './src/index.ts' });
 * compiler.run((error, stats) => console.log(stats?.toJson()));
 *
 * @param options Build configuration, when a compiler is returned.
 */
declare function webpack(options?: webpack.Configuration): webpack.Compiler;

/**
 * Starts a build and invokes the callback when it finishes.
 * @param options Build configuration for the asynchronous build.
 * @param callback Function called with the error and resulting statistics.
 * @returns Reports completion through the callback rather than returning a compiler.
 * @example
 * webpack({ entry: './src/index.ts' }, (error, stats) => console.log(stats?.toJson()));
 */
declare function webpack(options: webpack.Configuration, callback: webpack.Callback): void;

declare namespace webpack {
  /** A callback used by asynchronous compiler operations. */
  export type Callback = (error: Error | undefined, stats?: Stats) => void;

  /** A value paired with an optional typed error. */
  export type Result<T, E extends Error = Error> = {
    value: T;
    error?: E;
  };

  /**
   * The top-level configuration accepted by webpack.
   *
   * @see CompilerOptions for the compiler-specific settings.
   */
  export interface Configuration extends CompilerOptions {
    /** One or more module entry points. */
    entry?: string | string[];
    /** Output settings for emitted assets. */
    output?: OutputOptions;
    /** Human-readable build name. */
    name?: string;
  }

  /** Options that control compiler behavior. */
  export interface CompilerOptions {
    /** Enables a development-oriented build. */
    mode?: 'development' | 'production' | 'none';
    /** Enables persistent filesystem caching. */
    cache?: boolean | CacheOptions;
    /** Prints progress while compiling. */
    profile?: boolean;
  }

  /** Options for persistent compiler caching. */
  export interface CacheOptions {
    /** Cache storage strategy. */
    type: 'memory' | 'filesystem';
    /** Optional directory used for filesystem storage. */
    directory?: string;
  }

  /** Options used to name and write generated files. */
  export interface OutputOptions {
    /** Directory where assets are emitted. */
    path?: string;
    /** Filename pattern for the main bundle. */
    filename?: string;
    /** Public URL prefix for emitted assets. */
    publicPath?: string;
  }

  /** Options for watching source files. */
  export interface WatchOptions {
    /** Delay, in milliseconds, before rebuilding. */
    aggregateTimeout?: number;
    /** Filesystem polling interval, when enabled. */
    poll?: number | boolean;
  }

  /** Options controlling the detail included in statistics. */
  export interface StatsOptions {
    /** Include module information in the result. */
    modules?: boolean;
    /** Include timing information in the result. */
    timings?: boolean;
    /** Include asset details in the result. */
    assets?: boolean;
    /** Include source locations in messages. */
    children?: boolean;
  }

  /**
   * Coordinates builds and exposes the compiler lifecycle hooks.
   *
   * A compiler is created by calling the root {@link webpack} function. Its
   * hooks can be used by integrations to observe compilation progress.
   */
  export class Compiler {
    /**
     * Creates a compiler for the supplied context and options.
     * @param context Base directory for module resolution.
     * @param options Compiler behavior settings.
     */
    constructor(context: string, options: CompilerOptions);

    /** Directory from which relative module requests are resolved. */
    context: string;
    /** Options used to create this compiler. */
    options: CompilerOptions;
    /** Lifecycle hooks exposed to compiler integrations. */
    hooks: Hooks;

    /**
     * Runs one compilation and invokes the callback with its statistics.
     * @param callback Called when the compilation completes.
     */
    run(callback: Callback): void;
    /** Watches files and calls the handler after each compilation. */
    watch(watchOptions: WatchOptions, handler: Callback): Watching;
    /** Stops active work and releases compiler resources. */
    close(callback: (error?: Error) => void): void;
    /** Gets a named logger for infrastructure messages. */
    getInfrastructureLogger(name: string): Logger;
  }

  /** Lifecycle hooks available on a compiler. */
  export interface Hooks {
    /** Called before a compilation begins. */
    beforeRun: Hook<() => void>;
    /** Called when a compilation has completed. */
    done: Hook<(stats: Stats) => void>;
  }

  /** A small lifecycle hook abstraction used by integrations. */
  export interface Hook<T extends (...args: any[]) => any> {
    /** Registers a listener and returns an unsubscribe function. */
    tap(name: string, listener: T): () => void;
    /**
     * Registers a listener with execution options.
     * @param options Listener name and whether it should run only once.
     * @param listener Callback matching the hook's signature.
     * @example
     * compiler.hooks.done.tap({ name: 'report', once: true }, stats => console.log(stats.toJson()));
     */
    tap<U extends T = T>(options: { name: string; once?: boolean }, listener: U): () => void;
  }

  /** Handle returned by a watch operation. */
  export interface Watching {
    /** Stops watching and releases its file watchers. */
    close(callback?: (error?: Error) => void): void;
  }

  /** Logger returned for infrastructure messages. */
  export interface Logger {
    /** Writes an informational message. */
    info(message: string): void;
    /** Writes a warning message. */
    warn(message: string): void;
  }

  /** Result of a completed compilation. */
  export class Compilation {
    /** Creates a compilation associated with a compiler. */
    constructor(compiler: Compiler);

    /** Compiler that owns this compilation. */
    compiler: Compiler;
    /** Assets produced by this compilation, keyed by filename. */
    assets: Record<string, Asset>;
    /** Returns a compact summary of the compilation. */
    getStats(): Stats;
    /** Adds or replaces an emitted asset. */
    emitAsset(name: string, asset: Asset): void;
  }

  /** A generated output asset. */
  export interface Asset {
    /** Asset source contents. */
    source: string;
    /** Asset size in bytes. */
    size: number;
  }

  /** Summary information for a build. */
  export class Stats {
    /** Creates a statistics object from a compilation. */
    constructor(compilation: Compilation);

    /** Whether the compilation completed without errors. */
    hasErrors(): boolean;
    /** Whether the compilation emitted warnings. */
    hasWarnings(): boolean;
    /** Serializes selected statistics for reporting. */
    toJson(options?: StatsOptions): StatsJson;
    /** Formats the statistics as human-readable text. */
    toString(options?: StatsOptions): string;
  }

  /** JSON-friendly statistics output. */
  export interface StatsJson {
    /** Number of emitted assets. */
    assets: number;
    /** Number of modules included in the build. */
    modules: number;
    /** Build duration in milliseconds. */
    time: number;
  }

  /** Validates a configuration without starting a build. */
  export function validate(configuration: Configuration): void;

  /** Starts a watched compiler and returns its watch handle. */
  export function watch(
    configuration: Configuration,
    options: WatchOptions,
    handler: Callback,
  ): Watching;

  /** Common source utilities. */
  export namespace util {
    /** Joins paths using webpack's normalized separator. */
    export function join(...parts: string[]): string;
    /** Converts a value to a stable, printable label. */
    export function format(value: unknown): string;
    /** Maps a value while preserving the input type when no mapper result is supplied. */
    export function mapValue<T, U = T>(value: T, mapper: (value: T) => U): U;
  }

  /** Built-in source implementations. */
  export namespace sources {
    /** A source backed by a string value. */
    export class RawSource {
      /** Creates a source from raw text. */
      constructor(value: string);
      /** Returns the source text. */
      source(): string;
      /** Returns the source length in bytes. */
      size(): number;
    }

    /** A source that adds a license banner to another source. */
    export class BannerSource extends RawSource {
      /** Creates a banner-wrapped source. */
      constructor(source: RawSource, banner: string);
      /** Returns the banner and wrapped source text. */
      source(): string;
    }
  }

  /** Typed stores used by compiler integrations. */
  export namespace stores {
    /** A named value available from a store. */
    export interface Entry<T extends Asset = Asset> {
      /** Current stored asset. */
      value: T;
      /** Reads the current asset when it matches the supplied name. */
      read(name?: string): T;
    }

    /** A typed store with documented overloads. */
    export class Store<T extends Asset = Asset> implements Entry<T> {
      /** Creates a store, optionally preloaded with an asset. */
      constructor(value?: T);
      /** Current stored asset. */
      value: T;
      /** Reads the current asset. */
      read(name?: string): T;
      /**
       * Selects assets with a predicate.
       *
       * The result preserves the selected asset subtype.
       * @param predicate Function used to select assets.
       * @param limit Maximum number of results.
       * @returns Selected assets.
       * @example store.select(asset => asset.size > 0, 10);
       */
      select<U extends T = T>(predicate: (asset: U) => boolean, limit?: number): U[];
      /**
       * Selects assets by name.
       * @param names Names of assets to select.
       * @returns Matching assets.
       * @example store.select('main.js', 'runtime.js');
       */
      select(...names: string[]): T[];
      /** Applies a generic mapping to the current asset. */
      map<U extends Asset = T>(mapper: (asset: T) => U): U;
      /** Creates a label for a stored asset. */
      static label(name: string): string;
    }

    /** A store whose inherited generic members use Asset. */
    export class AssetStore extends Store<Asset> {
      /** Indicates whether this store can be persisted. */
      persistent: boolean;
    }

    /** An entry extended by more than one interface. */
    export interface NamedEntry extends Entry<Asset>, Logger {
      /** Unique asset name. */
      name: string;
    }

    /**
     * Creates a typed store.
     * @param value Initial asset.
     * @param labels Optional labels for the store.
     * @example stores.createStore({ source: '', size: 0 }, 'initial');
     */
    export function createStore<T extends Asset = Asset>(value?: T, ...labels: string[]): Store<T>;
  }

  /** Separate cache implementations with independently named types. */
  export namespace cache {
    /** A cache store with the same unqualified name as stores.Store. */
    export class Store<T extends string = string> {
      /** Creates a cache store. */
      constructor(key?: T);
      /** Looks up a cache key. */
      read(key?: T): T | undefined;
    }
    /** A cache entry with the same unqualified name as stores.Entry. */
    export interface Entry<T extends string = string> {
      /** Cached text. */
      value: T;
    }
  }
}

export = webpack;
