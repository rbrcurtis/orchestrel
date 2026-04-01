import { Entity, PrimaryGeneratedColumn, Column, BaseEntity } from 'typeorm';

@Entity({ name: 'users' })
export class User extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ type: 'text', default: 'user' })
  role!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

@Entity({ name: 'project_users' })
export class ProjectUser extends BaseEntity {
  @Column({ name: 'project_id', type: 'integer', primary: true })
  projectId!: number;

  @Column({ name: 'user_id', type: 'integer', primary: true })
  userId!: number;
}
