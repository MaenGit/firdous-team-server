import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { RagModule } from '../rag/rag.module';
import { LlmService } from '../llm/llm.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma.service'; // استيراد هنا احتياطاً لضمان عمل الـ provider

@Module({
  imports: [
    RagModule, // هذا السطر سيجلب الـ RagService والـ PrismaService المصدرين أعلاه
    ConfigModule,
  ],
  controllers: [TelegramController],
  providers: [TelegramService, LlmService, PrismaService], // أضفنا PrismaService هنا بشكل صريح للـ TelegramService
})
export class TelegramModule {}