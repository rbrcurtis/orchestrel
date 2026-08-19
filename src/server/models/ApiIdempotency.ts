import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'api_idempotency' })
export class ApiIdempotency extends BaseEntity {
  @PrimaryColumn({ name: 'request_key', type: 'text' })
  requestKey!: string;

  @Column({ type: 'text' })
  operation!: string;

  @Column({ name: 'request_hash', type: 'text' })
  requestHash!: string;

  @Column({ name: 'response_json', type: 'text' })
  responseJson!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}
