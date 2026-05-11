export abstract class Mutator {
  abstract execute(): Promise<Boolean>;
}
