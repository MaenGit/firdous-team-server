import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RagService } from './rag.service';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [ConfigModule],
  providers: [RagService, PrismaService],
  exports: [RagService, PrismaService], // تأكد من تصدير الخدمتين معاً هنا
})
export class RagModule {}