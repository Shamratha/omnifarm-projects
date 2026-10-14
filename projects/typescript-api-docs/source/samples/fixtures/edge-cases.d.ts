/** Bundled parser fixture for generic, inherited, overloaded, and Markdown APIs. */
declare namespace webpack {
  namespace alpha {
    /**
     * A generic alpha item.
     *
     * <script>alert('this stays text')</script>
     * [safe docs](https://example.com/reference) [unsafe](javascript:alert(1))
     */
    export interface Item<T extends string = string> {
      /** Optional item value. */
      value?: T;
    }

    /** Base API inherited by derived declarations. */
    export interface Base<T extends string = string> {
      /** Reads an optional key. */
      read(key?: T): T;
    }

    /** A derived API keeps inherited members in the generated model. */
    export interface Derived extends Base<'derived'> {
      /** Optional metadata. */
      metadata?: string;
    }

    /**
     * Parses either a generic string or a variadic numeric input.
     * @param value Optional string input.
     */
    export function parse<T extends string = string>(value?: T): T;
    /**
     * Parses a numeric sequence.
     * @param value First numeric input.
     * @param rest Additional numeric inputs.
     * @example parse(1, 2, 3);
     */
    export function parse(value: number, ...rest: number[]): number[];

    /** A generic store with documented Markdown on a member. */
    export class Store<T extends Item = Item> {
      /** Maps the stored item to another item type. */
      map<U extends Item = T>(mapper: (item: T) => U): U;
    }
  }

  namespace beta {
    /** A duplicate name in a separate namespace. */
    export interface Item<T extends number = number> {
      value: T;
    }

    /** A second duplicate store name. */
    export class Store<T extends Item = Item> {
      /** Reads an optional numeric value. */
      read(value?: T): T;
    }
  }
}

export = webpack;
