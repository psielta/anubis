import { Book } from './book.model';

export interface Collection {
  id: number;
  name: string;
  book_count: number;
}

export interface CollectionShelf extends Collection {
  items: Book[];
}
