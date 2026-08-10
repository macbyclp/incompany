import { Module } from '@nestjs/common';

import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { UsersController, AdminUsersController } from './users.controller';
import { DepartmentsController } from './departments.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [UsersController, AdminUsersController, DepartmentsController],
  providers: [UsersRepository, UsersService],
})
export class UsersModule {}
